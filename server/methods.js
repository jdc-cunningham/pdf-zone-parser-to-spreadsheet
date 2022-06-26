require('dotenv').config();
const { pool } = require('./dbConnect');
const { writeDataToSpreadsheet } = require('./google-spreadsheet');
const fs = require('fs');
const AWS = require('aws-sdk');
const bucketName = process.env.AWS_S3_BUCKET_NAME;
const { createWorker } = require('tesseract.js');
const { getPdfCropImages, pdfImgPath, pdfLocalPath} = require('./pdf-screenshot-gen/generator');
const globalSubImages = [];

AWS.config.update({
  region: process.env.AWS_S3_REGION,
  accessKeyId: process.env.AWS_S3_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_S3_SECRET_ACCESS_KEY,
});

const s3 = new AWS.S3({apiVersion: '2006-03-01', signatureVersion: "v4"});

const _getDateTime = (format = '') => {
  // from https://stackoverflow.com/questions/8083410/how-can-i-set-the-default-timezone-in-node-js
  let date_ob = new Date();

  // current date
  // adjust 0 before single digit date
  let date = ("0" + date_ob.getDate()).slice(-2);

  // current month
  let month = ("0" + (date_ob.getMonth() + 1)).slice(-2);

  // current year
  let year = date_ob.getFullYear();

  // current hours
  let hours = date_ob.getHours();

  // current minutes
  let minutes = date_ob.getMinutes();

  // current seconds
  let seconds = date_ob.getSeconds();

  // prints date & time in YYYY-MM-DD HH:MM:SS format
  if (format === 'full') {
    return `${year}-${month}-${date} ${hours}:${minutes}:${seconds}`;
  } else {
    return `${year}-${month}-${date}`;
  }
}

const _makeRandomStr = (length) => {
  var result           = ''
  var characters       = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  var charactersLength = characters.length

  for ( var i = 0; i < length; i++ ) {
     result += characters.charAt(Math.floor(Math.random() * charactersLength))
  }

  return result
}

const _slugifyNoPdf = (text) => text
  .toLowerCase()
  .replace('.pdf', '')
  .replace(/[^\w-]+/g,'')
  .replace(/ +/g,'-');

const getShareEmail = (req, res) => {
  pool.query(
    `${'SELECT gsa_email, spreadsheet_id FROM util t1 INNER JOIN users t2 ON t1.id = t2.id'}`, // should only be one
    (err, qRes) => {
      if (err) {
        console.log(err);
        res.status(400).json({ok: false});
      } else {
        res.status(200).json({
          ok: true,
          sharedEmail: qRes[0].gsa_email,
          spreadsheetId: qRes[0].spreadsheet_id
        });
      }
    }
  );
}

const _insertUser = async (spreadsheetId) => {
  return new Promise(resolve => {
    pool.query(
      `${'INSERT INTO users SET user_name = ?, spreadsheet_id = ?'}`, // should only be one
      ['main', spreadsheetId],
      (err, qRes) => {
        if (err) {
          console.log(err);
          resolve(false);
        } else {
          resolve(1);
        }
      }
    );
  });
};

const _createUser = async (spreadsheetId) => {
  return new Promise(resolve => {
    pool.query(
      `${'SELECT id FROM users LIMIT 1'}`, // should only be one
      async (err, qRes) => {
        if (err) {
          console.log(err);
          resolve(false);
        } else {
          if (qRes[0]?.id) {
            resolve(1);
          } else {
            const userId = await _insertUser(spreadsheetId);
            userId ? resolve(true) : resolve(false);
          }
        }
      }
    );
  });
}

// this platform is designed for only 1 user right now
// assumes userId is 1
const saveSpreadsheetId = async (req, res) => {
  const spreadsheetSaved = await _createUser(req.body.spreadsheetId);
  
  if (spreadsheetSaved) {
    res.status(201).json({
      ok: true
    });
  } else {
    res.status(400).json({
      ok: false
    });
  }
}

const _addDocToTable = async (docMeta) => {
  const { fileName, fileKey, dateAdded } = docMeta;

  return new Promise(resolve => {
    pool.query(
      `${'INSERT INTO pdf_uploads SET user_id = 1, file_name = ?, file_key = ?, parsed = false, upload_date = ?'}`, // should only be one
      [fileName, fileKey, dateAdded],
      (err, qRes) => {
        if (err) {
          console.log(err);
          resolve(false);
        } else {
          resolve(1);
        }
      }
    );
  });
}

const uploadPdfs = async (req, res) => {
  const multerFilesArr = req.files;
  const promises = [];

  multerFilesArr.forEach(file => {
    promises.push(
      new Promise((resolve, reject) => {
        const fileName = file.originalname;
        const fileKey = `${_getDateTime()}_${_makeRandomStr(16)}_${_slugifyNoPdf(fileName)}.pdf`;
  
        fs.readFile(file.path, (err, buff) => {
          const uploadParams = {
            Bucket: bucketName,
            Key: fileKey,
            Body: buff,
            ContentType: 'application/pdf'
          };
      
          s3.upload(uploadParams, async (err, data) => {
            if (err) {
              console.log("Upload to s3 err" + err);
              reject(false);
            }

            if (data) {
              const uploadedMeta = {
                fileName: fileName,
                fileKey: fileKey,
                dateAdded: _getDateTime('full')
              };

              const pdfAddedToDb = await _addDocToTable(uploadedMeta);

              if (pdfAddedToDb) {
                resolve({
                  fileName,
                  fileKey
                });
              } else {
                console.log('failed db write');
                reject(false); // could mean duplicate uploads
              }
            }
            // delete from temporary folder
            fs.unlink(file.path, (err) => {
              if (err) {
                console.log(`failed to delete file ${fileName}`)
              }
            });
          });
        });
      })
    );
  });

  Promise
    .all(promises)
    .then((vals) => {
      res.status(200).json({ // this is brittle requiring all to work, no catch for partial failure
        ok: true,
        uploaded: vals
      });
    })
    .catch((err) => {
      console.log('promise all err', err);
      res.status(400).json({
        ok: false,
      });
    })
}

const getSignedS3Url = (req, res) => {
  const fileKey = req.body.fileKey;

  const url = s3.getSignedUrl('getObject', {
    Bucket: bucketName,
    Key: fileKey,
    Expires: 3600 // 1 hr
  });

  if (url) {
    res.status(200).json({
      ok: true,
      url
    });
  } else {
    res.status(400).json({
      ok: false
    });
  }
};

const _getSignedS3Url = (fileKey) => {
  const url = s3.getSignedUrl('getObject', {
    Bucket: bucketName,
    Key: fileKey,
    Expires: 3600 // 1 hr
  });

  return url
}

const _parsePdfPartialScreenshot = async (pdfZoneImagePath, worker) => {
  console.log('img', pdfZoneImagePath);
  const { data: { text } } = await worker.recognize(pdfZoneImagePath);
  // await worker.terminate();
  console.log('txt', text);
  return text.trim();
}

// object or boolean? yum
const _getPdfIdFromFileKey = async (fileKey) => {
  return new Promise(resolve => {
    pool.query(
      `${'SELECT id, user_id FROM pdf_uploads WHERE file_key = ?'}`,
      [fileKey],
      (err, qRes) => {
        if (err) {
          resolve(false);
        } else {
          resolve(qRes[0]);
        }
      }
    );
  });
}

const _updateDBParsedPdf = async (pdfParsedData) => {
  return new Promise(async (resolve) => {
    const { fileKey, subImagesZoneText } = pdfParsedData;
    const pdfMeta = await _getPdfIdFromFileKey(fileKey);

    if (pdfMeta?.id) {
      pool.query(
        `${'INSERT INTO pdf_parsed_data SET user_id = ?, pdf_id = ?, pdf_data_mapping = ?'}`,
        [pdfMeta.user_id, pdfMeta.id, JSON.stringify(pdfParsedData)],
        (err, qRes) => {
          if (err) {
            resolve(false);
          } else {
            resolve(true);
          }
        }
      );
    } else {
      resolve(false);
    }
  });
}

const _cleanUpPreviousProcessFiles = async (pdfPath, pdfImgPath, subImagePaths) => {
  const deletedFiles = [];

  return new Promise(resolve => {
    fs.unlink(pdfPath, (err => {
      if (err) console.log(err); // means files will build up
      deletedFiles.push(pdfPath);
    }));

    // lazy
    fs.unlink(pdfImgPath, (err => {
      if (err) console.log(err); // means files will build up
      deletedFiles.push(pdfImgPath);
    }));

    subImagePaths.forEach(path => {
      fs.unlink(path, (err => {
        if (err) console.log(err); // means files will build up
        deletedFiles.push(path);
      }));
    })

    // the above are synchronous so should be done here
    if (deletedFiles.length === 5) {
      resolve(true);
    } else {
      resolve(false);
    }
  });
}

// returns object with parsed data
const _processPdf = async (pdfInfo, pdfS3Url, pdfDimensions, cropZones, zoneColumnMap, insertAtRow, worker) => {
  const subImages = await getPdfCropImages(pdfInfo, pdfS3Url, pdfDimensions, cropZones, globalSubImages);
  const subImagesZoneText = {};
  const fileKey = pdfInfo.fileKey;

  // lazy
  for (let i = 0; i < subImages.length; i++) {
    const zoneId = subImages[i].split('/screenshots/')[1].split('.jpg')[0];
    const zoneText = await _parsePdfPartialScreenshot(subImages[i], worker);
    const colLetter = zoneColumnMap[`zone-${zoneId}`];

    // \n appears at the end of every parsed line, it's valid for block text
    // count occurences, multiple = block

    // https://stackoverflow.com/a/4009768/2710227
    const nlCount = (zoneText.match(/\n/g) || []).length;

    subImagesZoneText[`${colLetter}${parseInt(insertAtRow)}`] = nlCount > 1
      ? zoneText
      : zoneText.replace(/\n/g, '');
  }

  // await worker.terminate();

  return {
    fileKey,
    subImagesZoneText
  };
}

const _clientPing = async () => {
  return new Promise(resolve => {
    resolve(true); // for now
  });
}

// assumed user_id 1
const _getSheetId = async () => {
  return new Promise(resolve => {
    pool.query(
      `${'SELECT spreadsheet_id FROM users where id = 1'}`,
      (err, qRes) => {
        if (err) {
          console.log(err);
          resolve('');
        } else {
          resolve(qRes[0].spreadsheet_id);
        }
      }
    );
  });
}

const _processPdfs = async (reqBody) => {
  return new Promise(async (resolve) => {
    const { insertAtRow, pdfDimensions, pdfs, zoneColumnMap, zones } = reqBody;

    if (pdfs.length) {
      const sheetId = await _getSheetId();
      const promises = [];

      // start OCR
      const worker = createWorker({
        langPath: './eng.traineddata',
        // logger: m => console.log(m)
      });
      await worker.load();
      await worker.loadLanguage('eng');
      await worker.initialize('eng');

      pdfs.forEach(pdf => {
        promises.push(
          new Promise(async (resolve) => {
            const pdfS3Url = _getSignedS3Url(pdf.fileKey);
            const pdfParsedData = await _processPdf(pdf, pdfS3Url, pdfDimensions, zones, zoneColumnMap, insertAtRow, worker);
            const updatedDB = await _updateDBParsedPdf(pdfParsedData);
            const wroteToGS = await writeDataToSpreadsheet(pdfParsedData, sheetId);
            // await _cleanUpPreviousProcessFiles(pdfLocalPath, pdfImgPath, globalSubImages); // last global param bad
            // await _clientPing((updateDB && writeToGS), pdf.fileName); // ws

            console.log(updatedDB);
            console.log(wroteToGS);

            if (!updatedDB || !wroteToGS) {
              resolve(false);
            }

            resolve(true);
          })
        );
      });

      Promise
      .all(promises)
      .then(() => {
        resolve(true);
      })
      .catch(err => {
        console.log(err);
        resolve(false);
      })
      .finally(async () => {
        // end OCR
        await worker.terminate();
      });
    } else {
      resolve(true);
    }
  });
}

// const manualRun = async (reqBody) => {
//   const { insertAtRow, pdfDimensions, pdfs, zoneColumnMap, zones } = reqBody;
//   const pdfPath = _getSignedS3Url(pdfs[0].fileKey);
//   // start up OCR
//   await worker.load();
//   await worker.loadLanguage('eng');
//   await worker.initialize('eng');
//   const pdfParsedData = await _processPdf(pdfs[0].fileKey, pdfPath, pdfDimensions, zones, zoneColumnMap, insertAtRow);
//   console.log(pdfParsedData);
//   // end OCR
//   await worker.terminate();
//   // const updateDB = await _updateDBParsedPdf(pdfParsedData);
//   // const writeToGS = await writeToCell(insertAtRow, pdfParsedData);
//   // await _clientPing((updateDB && writeToGS), pdfs[0].fileName);
//   // pdfs.shift();
//   // _processPdfs(reqBody);
// }

const payload = {
  "pdfs": [
    {
      "fileName": "Sample PDF Parsing Target Doc.pdf",
      "fileKey": "2022-06-26_p2x62ezgZ8QvYN4Q_samplepdfparsingtargetdoc.pdf"
    },
    {
      "fileName": "Sample PDF Parsing Target Doc 2.pdf",
      "fileKey": "2022-06-26_46Xu2QHR7PS1bi2P_samplepdfparsingtargetdoc2.pdf"
    }
  ],
  "zones": [
    {
      "id": 1656276936930,
      "x": 442,
      "y": 185,
      "width": 151,
      "height": 30,
      "xOffset": -42,
      "yOffset": -88
    },
    {
      "id": 1656276940345,
      "x": 134,
      "y": 301,
      "width": 158,
      "height": 30,
      "xOffset": -42,
      "yOffset": -88
    },
    {
      "id": 1656276944501,
      "x": 133,
      "y": 401,
      "width": 165,
      "height": 63,
      "xOffset": -42,
      "yOffset": -88
    }
  ],
  "zoneColumnMap": {
    "zone-1656276936930": "A",
    "zone-1656276940345": "B",
    "zone-1656276944501": "C"
  },
  "pdfDimensions": {
    "width": 845,
    "height": 1093
  },
  "insertAtRow": "2"
};

// manualRun(payload);

const parsePdfZones = async (req, res) => {
  const processingFinished = await _processPdfs(req.body);

  if (processingFinished) {
    res.status(200).json({
      ok: true
    });
  } else {
    res.status(400).json({
      ok: false
    });
  }
}

module.exports = {
  getShareEmail,
  saveSpreadsheetId,
  uploadPdfs,
  getSignedS3Url,
  parsePdfZones
}