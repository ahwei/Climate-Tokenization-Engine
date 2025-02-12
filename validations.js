const Joi = require("joi");

const connectToOrgSchema = Joi.object({
  orgUid: Joi.string().required(),
});

const tokenizeUnitSchema = Joi.object({
  org_uid: Joi.string().required(),
  warehouseUnitId: Joi.string().required(),
  warehouse_project_id: Joi.string().required(),
  vintage_year: Joi.number().required(),
  sequence_num: Joi.number().required(),
  warehouseUnitId: Joi.string().required(),
  to_address: Joi.string().required(),
  amount: Joi.number().required(),
});

const compressedProtectedFileSchema = Joi.object({
  file: Joi.string().required(),
  password: Joi.string().required(),
});

module.exports = {
  connectToOrgSchema,
  tokenizeUnitSchema,
  compressedProtectedFileSchema,
};
