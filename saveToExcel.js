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

function mergeAdditionalData(additionalData) {
  if (!Array.isArray(additionalData)) {
    return additionalData || {};
  }
  
  return additionalData.reduce((acc, item) => {
    for (const [key, value] of Object.entries(item)) {
      if (acc[key]) {
        acc[key] += `, ${value}`;
      } else {
        acc[key] = value;
      }
    }
    return acc;
  }, {});
}

function processAllJsonFiles() {
  const dataDir = path.join(__dirname, 'data');
  const outputDir = path.join(__dirname, 'output');
  const allCsvRows = [];
  const headers = new Set(['Archived on', 'Timestamp', 'Region', 'Country', 'Country URL', 'Channel Name', 'Logo', 'Channel Page']);

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
                    };

                    // Add any other channel properties
                    for (const [key, value] of Object.entries(channel)) {
                      if (!['Channel Name', 'Logo', 'Channel Page', 'additional_data', 'Logo url'].includes(key)) {
                        headers.add(key);
                        rowData[key] = value;
                      }
                    }

                    // Merge additional_data
                    const mergedAdditionalData = mergeAdditionalData(channel.additional_data);
                    for (const [key, value] of Object.entries(mergedAdditionalData)) {
                      headers.add(key);
                      rowData[key] = value;
                    }

                    // Check and replace "Empty 3 url" columns
                    if (rowData['Empty 3 url']) {
                      rowData['Satellite satadresse url'] = rowData['Empty 3 url'];
                      delete rowData['Empty 3 url'];
                      headers.add('Satellite satadresse url');
                      headers.delete('Empty 3 url');
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

  // Merge 'Frequency' and 'Frequency text' columns
  allCsvRows.forEach(row => {
    if (row['Frequency text']) {
      row['Frequency'] = row['Frequency text'] + (row['Frequency'] ? `, ${row['Frequency']}` : '');
      delete row['Frequency text'];
    }
  });
  headers.delete('Frequency text');

  // Merge 'Beam' and 'Beam text' columns
  allCsvRows.forEach(row => {
    if (row['Beam text']) {
      row['Beam'] = row['Beam text'] + (row['Beam'] ? `, ${row['Beam']}` : '');
      delete row['Beam text'];
    }
  });
  headers.delete('Beam text');

  // Remove columns with no values
  const nonEmptyHeaders = Array.from(headers).filter(header => 
    allCsvRows.some(row => row[header] !== undefined && row[header] !== '')
  );

  // Remove 'Logo url' column if it exists
  headers.delete('Logo url');

  const csvContent = [
    nonEmptyHeaders.join(','),
    ...allCsvRows.map(row => 
      nonEmptyHeaders.map(header => {
        const value = row[header] || '';
        return `"${value.toString().replace(/"/g, '""')}"`;
      }).join(',')
    )
  ].join('\n');

  fs.writeFileSync(path.join(outputDir, 'ALL.csv'), csvContent, 'utf8');
  console.log('ALL.csv file has been saved');
}

processAllJsonFiles();