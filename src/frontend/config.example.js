// For local development only: copy to config.js and fill in values from `terraform output`.
// In AWS, Terraform writes config.js to the web bucket automatically.
window.SUPPLYRADAR_CONFIG = {
  apiUrl: "https://xxxxxxxxxx.execute-api.eu-central-1.amazonaws.com",
  region: "eu-central-1",
  userPoolId: "eu-central-1_XXXXXXXXX",
  clientId: "xxxxxxxxxxxxxxxxxxxxxxxxxx",
  environment: "dev"
};
