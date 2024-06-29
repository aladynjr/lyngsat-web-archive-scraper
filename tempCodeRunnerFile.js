const fs = require('fs');
const path = require('path');

function getMonthAbbr(monthNum) {
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  return months[parseInt(monthNum) - 1];
}

function formatDate(timestamp) {
  const year = timestamp.substring(0, 4);
  const month = getMonthAbbr(timestamp.substring(4, 6));
  return `${year}-${month}`;
}

function processAdditionalData(additionalData) {
  if (!Array.isArray(additionalData)) {
    return JSON.stringify(additionalData);
  }
  
  return additionalData.map(item => {
    return Object.entries(item)
      .map(([key, value]) => `${key}: ${value}`)
      .join('; ');
  }).join(' | ');
}

function processAllJsonFiles() {
  const dataDir = path.join(__dirname, 'data');
  const outputDir = path.join(__dirname, 'output');
  const allCsvRows = [];
  const headers = new Set(['Archived on', 'Timestamp', 'Region', 'Country', 'Country URL', 'Channel Name', 'Logo', 'Channel Page', 'Additional Data']);

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir);
  }

  fs.readdirSync(dataDir).forEach(file => {
    if (path.extname(file).toLowerCase() === '.json') {
      const jsonFilePath = path.join(dataDir, file);
      const jsonData = JSON.parse(fs.readFileSync(jsonFilePath, 'utf8'));

      for (const [timestamp, data] of Object.entries(jsonData)) {
        if (Array.isArray(data.regions)) {
          for (const region of data.regions) {
            if (Array.isArray(region.countries)) {
              for (const country of region.countries) {
                if (Array.isArray(country.channels)) {
                  for (const channel of country.channels) {
                    const rowData = {
                      'Archived on': formatDate(timestamp),
                      'Timestamp': timestamp,
                      'Region': region.name,
                      'Country': country.name,
                      'Country URL': country.url || '',
                      'Channel Name': channel['Channel Name'] || '',
                      'Logo': channel['Logo'] || '',
                      'Channel Page': channel['Channel Page'] || '',
                      'Additional Data': processAdditionalData(channel.additional_data)
                    };

                    // Add any other channel properties dynamically
                    for (const [key, value] of Object.entries(channel)) {
                      if (!['Channel Name', 'Logo', 'Channel Page', 'additional_data'].includes(key)) {
                        headers.add(key);
                        rowData[key] = value;
                      }
                    }

                    allCsvRows.push(rowData);
                  }
                }
              }
            }
          }
        }
      }
    }
  });

  const headerArray = Array.from(headers);
  const csvContent = [
    headerArray.join(','),
    ...allCsvRows.map(row => 
      headerArray.map(header => {
        const value = row[header] || '';
        return `"${value.toString().replace(/"/g, '""')}"`;
      }).join(',')
    )
  ].join('\n');

  fs.writeFileSync(path.join(outputDir, 'ALL.csv'), csvContent, 'utf8');
  console.log('ALL.csv file has been saved');
}

processAllJsonFiles();