"use strict";

const _ = require("lodash");
const express = require("express");
const joiExpress = require("express-joi-validation");
const bodyParser = require("body-parser");
const { createProxyMiddleware } = require("http-proxy-middleware");
const http = require("http");

const validator = joiExpress.createValidator({ passError: true });

const { connectToOrgSchema } = require("./validations.js");
const { getStoreIds } = require("./datalayer.js");

const app = express();
const port = 31311;

// TODO: create config.yaml to set this
const registryHost = "http://localhost:31310";

app.use(express.json());
app.use(bodyParser.urlencoded({ extended: false }));

app.use(
  `/units/tokenized`,
  createProxyMiddleware({
    target: registryHost,
    changeOrigin: true,
    secure: false,
    pathRewrite: {
      [`/units/tokenized`]: "/v1/units?hasMarketplaceIdentifier=true",
    },
  })
);

app.use(
  `/units/untokenized`,
  createProxyMiddleware({
    target: registryHost,
    changeOrigin: true,
    secure: false,
    pathRewrite: {
      [`/units/untokenized`]: "/v1/units?hasMarketplaceIdentifier=false",
    },
  })
);

app.post("/connect", validator.body(connectToOrgSchema), async (req, res) => {
  const orgUid = req.body.orgUid;
  const storeIds = await getStoreIds(orgUid);
  const isOrgUidIncludedInStoreIds = storeIds.some(
    (storeId) => storeId === orgUid
  );

  if (isOrgUidIncludedInStoreIds) {
    // if match save orgUid to db and use as homeOrg
    res.status(200).send("Org uid found, hurray!");
  } else {
    res.status(404).send("Not found.");
  }
});

app.get("/tokenize", (req, res) => {
  res.send("Not Yet Implemented");
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

app.listen(port, () => {
  console.log(`Application is running on port ${port}.`);
});
