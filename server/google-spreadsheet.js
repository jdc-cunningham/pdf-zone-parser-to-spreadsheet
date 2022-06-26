// based on https://isd-soft.com/tech_blog/accessing-google-apis-using-service-account-node-js/
// requires service account configured with key
// also have to share spreadsheet with your service account email

require('dotenv').config({
  path: __dirname + '/.env'
});

const { google } = require('googleapis');
const privateKey = require(`./${process.env.PRIVATE_KEY_JSON_PATH}`);
const sheets = google.sheets('v4');

const jwtClient = new google.auth.JWT(
  privateKey.client_email,
  null,
  privateKey.private_key,
  ['https://www.googleapis.com/auth/spreadsheets']
);

const authenticate = async () => {
  return new Promise(resolve => {
    jwtClient.authorize(function (err, tokens) {
      resolve(!err);
    });
  });
};

const writeDataToSpreadsheet = async (data, sheetId) => {
  const authenticated = await authenticate();
  const { subImagesZoneText } = data;

  console.log(authenticated);
  console.log(subImagesZoneText);

  return new Promise(async (resolve) => {
    if (authenticated) {
      const cells = Object.keys(subImagesZoneText);
      const first = cells[0];
      const last = cells[cells.length - 1];
      const range = `Sheet1!${first}:${last}`; // very brittle
      const resource = Object.keys(subImagesZoneText).map(cell => subImagesZoneText[cell]);

      console.log(range);
      console.log(resource);

      sheets.spreadsheets.values.update({
        auth: jwtClient,
        spreadsheetId: sheetId,
        range,
        resource,
        valueInputOption: 'RAW',
      }, (err, res) => {
        if (err) {
          // handle this err
          console.log(err);
        } else {
          resolve(true);
        }
      });
    } else {
      resolve(false);
    }
  });
}

module.exports = {
  writeDataToSpreadsheet
};