const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const url = require('url');
const cheerio = require('cheerio');

async function fetchArchivedUrlsForEachMonth(url, fromDate, toDate) {
  const waybackApiUrl = "http://web.archive.org/cdx/search/cdx";
  const availableUrls = {};

  const params = {
    url: url,
    from: fromDate,
    to: toDate,
    output: "json",
    fl: "timestamp,original",
    filter: ["statuscode:200"],
    collapse: "timestamp:6"   // 1 capture per month
  };

  try {
    const response = await axios.get(waybackApiUrl, { params });
    const data = response.data;

    if (data.length > 1) {
      const urlDict = Object.fromEntries(
        data.slice(1).map(item => [
          item[0],
          `http://web.archive.org/web/${item[0]}/${item[1]}`
        ])
      );
      Object.assign(availableUrls, urlDict);
    }
  } catch (error) {
    console.error(`Error fetching data for ${url}:`, error.message);
  }

  if (Object.keys(availableUrls).length > 0) {
    const outputFileName = path.join(__dirname, 'wayback_urls.json');
    await fs.writeFile(outputFileName, JSON.stringify(availableUrls, null, 2));
    console.log(`Done: Wayback URLs saved to ${outputFileName}`);
  } else {
    console.log('No results found for the given URL and date range.');
  }
}



async function fetchAndLogFreeTVLinks(urls) {
    for (const baseUrl of urls) {
      try {
        const response = await axios.get(baseUrl);
        const $ = cheerio.load(response.data);
        $('a').each((i, link) => {
          const text = $(link).text().trim(); // Trim whitespace from the text
          let href = $(link).attr('href') ? $(link).attr('href').trim() : ''; // Ensure href exists and trim whitespace
  
          // Resolve the absolute URL from the base URL and the href
          const completeUrl = url.resolve(baseUrl, href);
  
          // Check if text includes 'Free TV' and href includes both 'free' and 'index'
          if (text.includes('Free TV') && href.includes('free') && href.includes('index')) {
            console.log(`Found link: ${text} (${completeUrl}) at ${baseUrl}`);
          }
        });
      } catch (error) {
        console.error(`Error fetching or parsing ${baseUrl}: ${error.message}`);
      }
    }
  }
  
  
async function main() {
  const host = 'http://www.lyngsat.com';
  const fromDate = '20000101';  // Start date: January 1, 2000
  const toDate = new Date().toISOString().slice(0, 10).replace(/-/g, '');  // End date: Today
  const outputFileName = path.join(__dirname, 'wayback_urls.json');

  try {
    await fs.access(outputFileName);
    console.log('Wayback URLs file already exists. Reading from file...');
  } catch (error) {
    console.log('Wayback URLs file not found. Fetching archived URLs...');
    await fetchArchivedUrlsForEachMonth(host, fromDate, toDate);
  }


  try {
    const fileContent = await fs.readFile(outputFileName, 'utf8');
    let urlsObject = JSON.parse(fileContent);
    let urls = Object.values(urlsObject);

    await fetchAndLogFreeTVLinks(urls);
  } catch (error) {
    console.error('Error reading or parsing the JSON file:', error);
  }


}



main().catch(error => {
  console.error('An error occurred:', error);
  process.exit(1);
});