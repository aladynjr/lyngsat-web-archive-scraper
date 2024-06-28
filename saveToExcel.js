const fs = require('fs');
const path = require('path');

function convertJsonToCsv(jsonData, outputFilePath) {
  const csvRows = [];
  const headers = new Set(['Timestamp', 'Region', 'Country', 'Channel Name', 'Logo', 'Channel Page']);

  // Function to flatten nested objects
  function flattenObject(obj, prefix = '') {
    return Object.keys(obj).reduce((acc, k) => {
      const pre = prefix.length ? prefix + '.' : '';
      if (typeof obj[k] === 'object' && obj[k] !== null && !Array.isArray(obj[k])) {
        Object.assign(acc, flattenObject(obj[k], pre + k));
      } else {
        acc[pre + k] = obj[k];
      }
      return acc;
    }, {});
  }

  // First pass: collect all possible headers
  for (const [timestamp, data] of Object.entries(jsonData)) {
    if (Array.isArray(data.regions)) {
      for (const region of data.regions) {
        if (Array.isArray(region.countries)) {
          for (const country of region.countries) {
            if (Array.isArray(country.channels)) {
              for (const channel of country.channels) {
                if (Array.isArray(channel.additional_data)) {
                  for (const additionalData of channel.additional_data) {
                    Object.keys(flattenObject(additionalData)).forEach(header => headers.add(header));
                  }
                } else if (typeof channel.additional_data === 'object' && channel.additional_data !== null) {
                  Object.keys(flattenObject(channel.additional_data)).forEach(header => headers.add(header));
                }
              }
            }
          }
        }
      }
    }
  }

  const headerArray = Array.from(headers);
  csvRows.push(headerArray.join(','));

  // Second pass: create CSV rows
  for (const [timestamp, data] of Object.entries(jsonData)) {
    if (Array.isArray(data.regions)) {
      for (const region of data.regions) {
        if (Array.isArray(region.countries)) {
          for (const country of region.countries) {
            if (Array.isArray(country.channels)) {
              for (const channel of country.channels) {
                const rowData = {
                  Timestamp: timestamp,
                  Region: region.name,
                  Country: country.name,
                  'Channel Name': channel['Channel Name'],
                  Logo: channel.Logo,
                  'Channel Page': channel.channel_page
                };

                let additionalDataMerged = {};
                if (Array.isArray(channel.additional_data)) {
                  additionalDataMerged = channel.additional_data.reduce((acc, curr) => {
                    const flattened = flattenObject(curr);
                    for (const [key, value] of Object.entries(flattened)) {
                      if (acc[key]) {
                        acc[key] += `, ${value}`;
                      } else {
                        acc[key] = value;
                      }
                    }
                    return acc;
                  }, {});
                } else if (typeof channel.additional_data === 'object' && channel.additional_data !== null) {
                  additionalDataMerged = flattenObject(channel.additional_data);
                }

                const fullRowData = { ...rowData, ...additionalDataMerged };
                
                const row = headerArray.map(header => {
                  const value = fullRowData[header] || '';
                  return `"${value.toString().replace(/"/g, '""')}"`;
                });

                csvRows.push(row.join(','));
              }
            }
          }
        }
      }
    }
  }

  const csvContent = csvRows.join('\n');

  fs.writeFileSync(outputFilePath, csvContent, 'utf8');
  console.log(`CSV file has been saved to: ${outputFilePath}`);
}

const jsonFilePath = path.join(__dirname, 'data', '201501021953252024-06-28.json');
const jsonData = JSON.parse(fs.readFileSync(jsonFilePath, 'utf8'));

const outputFilePath = path.join(__dirname, 'output.csv');
convertJsonToCsv(jsonData, outputFilePath);