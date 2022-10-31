"use strict";

const request = require("request-promise");
const _ = require("lodash");
const express = require("express");
const joiExpress = require("express-joi-validation");
const bodyParser = require("body-parser");
const cors = require("cors");
const os = require("os");
const formData = require("express-form-data");

const { createProxyMiddleware } = require("http-proxy-middleware");
const http = require("http");

const validator = joiExpress.createValidator({ passError: true });

const { updateConfig, getConfig } = require("./utils/config-loader");
const { connectToOrgSchema, tokenizeUnitSchema } = require("./validations.js");
const { getStoreIds } = require("./datalayer.js");
const { unzipAndUnlockZipFile } = require("./utils/decompress");

const app = express();
const port = 31311;
const CONFIG = getConfig();

const headerKeys = Object.freeze({
  ORG_UID: "x-org-uid",
});
app.use(
  cors({
    exposedHeaders: Object.values(headerKeys).join(","),
  })
);
const options = {
  uploadDir: os.tmpdir(),
  autoClean: true,
};
app.use(formData.parse(options));
app.use(express.json());
app.use(bodyParser.urlencoded({ extended: false }));

const updateQueryWithParam = (query, ...params) => {
  const currentParams = new URLSearchParams(query);
  params.forEach((paramItem) => {
    if (paramItem) {
      currentParams.append(paramItem.param, paramItem.value);
    }
  });
  const newParams = currentParams.toString();
  return `?${newParams}`;
};

app.use(async function (req, res, next) {
  try {
    if (CONFIG.HOME_ORG === null) {
      throw new Error("Home Org does not exist.");
    }
    next();
  } catch (err) {
    res.status(400).json({
      message: "Chia Exception",
      error: err.message,
    });
  }
});

app.use(
  `/units/tokenized`,
  createProxyMiddleware({
    target: CONFIG.REGISTRY_HOST,
    changeOrigin: true,
    secure: false,
    pathRewrite: async function (path, req) {
      const currentUrl = new URL(`${CONFIG.REGISTRY_HOST}${path}`);

      const newQuery = updateQueryWithParam(
        currentUrl.search,
        {
          param: "hasMarketplaceIdentifier",
          value: true,
        },
        {
          param: "orgUid",
          value: CONFIG.HOME_ORG,
        }
      );

      const newPath = "/v1/units" + newQuery;
      return newPath;
    },
    onProxyRes(proxyRes, req, res) {
      if (CONFIG.HOME_ORG) {
        proxyRes.headers["Access-Control-Expose-Headers"] = "x-org-uid";
        proxyRes.headers["x-org-uid"] = CONFIG.HOME_ORG;
      }
    },
  })
);

app.use(
  `/projects`,
  createProxyMiddleware({
    target: CONFIG.REGISTRY_HOST,
    changeOrigin: true,
    secure: false,
    pathRewrite: async function (path, req) {
      const currentUrl = new URL(`${CONFIG.REGISTRY_HOST}${path}`);

      const newQuery = updateQueryWithParam(currentUrl.search, {
        param: "orgUid",
        value: CONFIG.HOME_ORG,
      });

      const newPath = "/v1/projects" + newQuery;
      return newPath;
    },
    onProxyRes(proxyRes, req, res) {
      if (CONFIG.HOME_ORG) {
        proxyRes.headers["Access-Control-Expose-Headers"] = "x-org-uid";
        proxyRes.headers["x-org-uid"] = CONFIG.HOME_ORG;
      }
    },
  })
);

app.use(
  `/units/untokenized`,
  createProxyMiddleware({
    target: CONFIG.REGISTRY_HOST,
    changeOrigin: true,
    secure: false,
    pathRewrite: async function (path, req) {
      const currentUrl = new URL(`${CONFIG.REGISTRY_HOST}${path}`);

      const newQuery = updateQueryWithParam(
        currentUrl.search,
        {
          param: "hasMarketplaceIdentifier",
          value: false,
        },
        {
          param: "orgUid",
          value: CONFIG.HOME_ORG,
        }
      );

      const newPath = "/v1/units" + newQuery;
      return newPath;
    },
    onProxyRes(proxyRes, req, res) {
      if (CONFIG.HOME_ORG) {
        proxyRes.headers["Access-Control-Expose-Headers"] = "x-org-uid";
        proxyRes.headers["x-org-uid"] = CONFIG.HOME_ORG;
      }
    },
  })
);

app.post("/connect", validator.body(connectToOrgSchema), async (req, res) => {
  const orgUid = req.body.orgUid;
  try {
    const storeIds = await getStoreIds(orgUid);

    if (storeIds.includes(orgUid)) {
      updateConfig({ HOME_ORG: orgUid });
      res.json({ message: "successfully connected" });
    } else {
      throw new Error("orgUid not found");
    }
  } catch (error) {
    res.status(400).json({
      message: "Error connecting orgUid",
      error: error.message,
    });
  }
});

const updateUnitMarketplaceIdentifierWithAssetId = async (
  warehouseUnitId,
  asset_id
) => {
  try {
    const unitToBeUpdatedResponse = await request({
      method: "get",
      url: `${CONFIG.REGISTRY_HOST}/v1/units?warehouseUnitId=${warehouseUnitId}`,
    });

    const unitToBeUpdated = JSON.parse(unitToBeUpdatedResponse);
    unitToBeUpdated.marketplaceIdentifier = asset_id;

    delete unitToBeUpdated?.issuance?.orgUid;
    delete unitToBeUpdated.issuanceId;
    delete unitToBeUpdated.orgUid;
    delete unitToBeUpdated.serialNumberBlock;

    Object.keys(unitToBeUpdated).forEach(function (key, index) {
      if (this[key] == null) delete this[key];
    }, unitToBeUpdated);

    const updateUnitResponse = await request({
      method: "put",
      url: `${CONFIG.REGISTRY_HOST}/v1/units`,
      body: JSON.stringify(unitToBeUpdated),
      headers: { "Content-Type": "application/json" },
    });

    const data = JSON.parse(updateUnitResponse);

    await request({
      method: "post",
      url: `${CONFIG.REGISTRY_HOST}/v1/staging/commit`,
    });
  } catch (error) {
    console.log(
      "Could not update unit marketplace identifier with asset id.",
      error
    );
  }
};

const confirmTokenRegistrationOnWarehouse = async (
  token,
  transactionId,
  retry = 0
) => {
  if (retry <= 60) {
    try {
      const response = await request({
        method: "get",
        url: `${CONFIG.REGISTRY_HOST}/v1/staging/hasPendingTransactions`,
      });

      const data = JSON.parse(response);
      const thereAreNoPendingTransactions = data?.confirmed;

      if (thereAreNoPendingTransactions) {
        return true;
      } else {
        await new Promise((resolve) => setTimeout(() => resolve(), 30000));
        return confirmTokenRegistrationOnWarehouse(
          token,
          transactionId,
          retry + 1
        );
      }
    } catch (error) {
      return false;
    }
  }
  return false;
};

const registerTokenCreationOnClimateWarehouse = async (
  token,
  warehouseUnitId
) => {
  try {
    const response = await request({
      url: `${CONFIG.REGISTRY_HOST}/v1/organizations/metadata`,
      method: "post",
      body: JSON.stringify({
        [token.asset_id]: token,
      }),
    });

    const data = JSON.parse(response);

    if (
      data.message ===
      "Home org currently being updated, will be completed soon."
    ) {
      const isTokenRegistered = await confirmTokenRegistrationOnWarehouse();

      if (isTokenRegistered) {
        await updateUnitMarketplaceIdentifierWithAssetId(
          warehouseUnitId,
          token.asset_id
        );
      }
    } else {
      console.log("Could not register token creation on climate warehouse.");
    }
  } catch (error) {
    console.log(
      "Could not register token creation on climate warehouse.",
      error.message
    );
  }
};

const confirmTokenCreationWithTransactionId = async (
  token,
  transactionId,
  retry = 0
) => {
  if (retry <= 60) {
    try {
      const response = await request({
        method: "get",
        url: `${CONFIG.TOKENIZE_DRIVER_HOST}/v1/transactions/${transactionId}`,
      });

      const data = JSON.parse(response);
      const isTokenCreationConfirmed = data?.record?.confirmed;

      if (isTokenCreationConfirmed) {
        return true;
      } else {
        await new Promise((resolve) => setTimeout(() => resolve(), 30000));
        return confirmTokenCreationWithTransactionId(
          token,
          transactionId,
          retry + 1
        );
      }
    } catch (error) {
      return false;
    }
  }
  return false;
};

app.post("/tokenize", validator.body(tokenizeUnitSchema), async (req, res) => {
  try {
    const tokenizeRequestOptions = {
      url: `${CONFIG.TOKENIZE_DRIVER_HOST}/v1/tokens`,
      method: "post",
      body: JSON.stringify({
        token: {
          org_uid: req.body.org_uid,
          warehouse_project_id: req.body.warehouse_project_id,
          vintage_year: req.body.vintage_year,
          sequence_num: req.body.sequence_num,
        },
        payment: {
          amount: 100,
          fee: 100,
          to_address: req.body.to_address,
        },
      }),
      headers: { "Content-Type": "application/json" },
    };
    const response = await request(tokenizeRequestOptions);
    const data = JSON.parse(response);
    const isTokenCreationPending = Boolean(data?.tx?.id);

    if (isTokenCreationPending) {
      res.send(
        "Your token is being created and should be ready in a few minutes."
      );

      const isTokenCreationConfirmed =
        await confirmTokenCreationWithTransactionId(data.token, data.tx.id);

      if (isTokenCreationConfirmed) {
        await registerTokenCreationOnClimateWarehouse(
          data.token,
          req.body.warehouseUnitId
        );
      } else {
        console.log("Token creation could not be confirmed.");
      }
    } else {
      throw new Error(data.error);
    }
  } catch (error) {
    res.status(400).json({
      message: "Error token could not be created",
      error: error.message,
    });
  }
});

const sendDetokenizeRequest = async (detokString) => {
  try {
    const url = `${CONFIG.TOKENIZE_DRIVER_HOST}/v1/tokens/parse-detokenization?content=${detokString}`;
    const response = await request({
      method: "get",
      url,
    });

    const data = JSON.parse(response);
    return data;
  } catch (error) {
    throw new Error(`Detokenize api could not process request: ${error}`);
  }
};

app.post("/detokenize", async (req, res) => {
  try {
    const password = req.body.password;
    const filePath = req.files.file.path;

    const detokString = await unzipAndUnlockZipFile(filePath, password);
    const detokStringkIsValid =
      typeof detokString === "string" && detokString.startsWith("detok");
    if (!detokStringkIsValid) {
      throw new Error("Uploaded file not valid.");
    }

    const detokenizeRequestResponse = await sendDetokenizeRequest(detokString);
    console.log("detokenizeRequestResponse", detokenizeRequestResponse);

    res.send(detokenizeRequestResponse);
  } catch (error) {
    res.status(400).json({
      message: "File could not be detokenized.",
      error: error.message,
    });
  }
});

app.use((err, req, res, next) => {
  if (err) {
    if (_.get(err, "error.details")) {
      // format Joi validation errors
      return res.status(400).json({
        message: "Data Validation error",
        errors: err.error.details.map((detail) => {
          return _.get(detail, "context.message", detail.message);
        }),
      });
    }

    return res.status(err.status).json(err);
  }

  next();
});

app.use((req, res, next) => {
  if (CONFIG.HOME_ORG) {
    res.setHeader(headerKeys.ORG_UID, CONFIG.HOME_ORG);
  }

  next();
});

app.listen(port, () => {
  console.log(`Application is running on port ${port}.`);
});
