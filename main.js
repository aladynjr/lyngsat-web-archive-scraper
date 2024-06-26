const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const url = require('url');
const cheerio = require('cheerio');
const clc = require('cli-color');
require('dotenv').config();
const HttpsProxyAgent = require('https-proxy-agent');

const proxyUrl = process.env.PROXY_URL;
const httpsAgent = new HttpsProxyAgent(proxyUrl);


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
        console.log(clc.cyan(`\n📡 Fetching archived URLs for ${url}...\n`));
        const response = await axios.get(waybackApiUrl, { params, httpsAgent });
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
        console.error(clc.red(`\n❌ Error fetching data for ${url}:`), error.message);
    }

    if (Object.keys(availableUrls).length > 0) {
        const outputFileName = path.join(__dirname, 'wayback_urls.json');
        await fs.writeFile(outputFileName, JSON.stringify(availableUrls, null, 2));
        console.log(clc.green(`\n✅ Done: Wayback URLs saved to ${outputFileName}\n`));
    } else {
        console.log(clc.yellow('\n⚠️ No results found for the given URL and date range.\n'));
    }
}

async function fetchAndLogFreeTVLinks(urls) {
    for (const baseUrl of urls) {
        console.log(clc.cyan(`\n🔍 Processing base URL: ${baseUrl}\n`));

        try {
            // Step 1: Fetch the base URL
            const response = await axios.get(baseUrl, { httpsAgent });
            const $ = cheerio.load(response.data);

            // Step 2: Extract the "Free TV" URL
            let freeTvUrl = null;
            $('a').each((i, link) => {
                const text = $(link).text().trim();
                const href = $(link).attr('href') ? $(link).attr('href').trim() : '';

                if (text.includes('Free TV') && href.includes('free') && href.includes('index')) {
                    freeTvUrl = url.resolve(baseUrl, href);
                    return false; // Break the loop once we find a match
                }
            });

            if (freeTvUrl) {
                console.log(clc.green(`📺 Found Free TV URL: ${freeTvUrl}\n`));

                // Step 3: Fetch and process the Free TV page
                const freeTvResponse = await axios.get(freeTvUrl, { httpsAgent });
                const freeTv$ = cheerio.load(freeTvResponse.data);

                const regionLinks = [];

                freeTv$('b').each((i, bElement) => {
                    const $bElement = freeTv$(bElement);
                    const aElements = $bElement.find('a');
                    const bTextWithoutAnchors = $bElement.clone().children().remove().end().text().trim();

                    // Check if "Free" is in the text content of <b> or in the first anchor
                    const isFreePresentInB = bTextWithoutAnchors.includes('Free');
                    const isFreePresentInFirstAnchor = aElements.length > 0 && freeTv$(aElements[0]).text().trim().startsWith('Free');

                    if (aElements.length > 0 && (isFreePresentInB || isFreePresentInFirstAnchor)) {
                        const bText = $bElement.text().trim().replace(/\s+/g, ' ');
                        console.log(clc.yellow(`📌 Found b element: ${bText}`));

                        // Extract and log each anchor's text and href
                        aElements.each((j, aElement) => {
                            const $aElement = freeTv$(aElement);
                            const aText = $aElement.text().trim();
                            const aHref = $aElement.attr('href');
                            const fullUrl = aHref ? url.resolve(freeTvUrl, aHref) : 'N/A';
                            console.log(clc.magenta(`   🔗 Link ${j + 1}:`));
                            console.log(clc.magenta(`      Text: ${aText}`));
                            console.log(clc.magenta(`      URL: ${fullUrl}`));

                            // Add to regionLinks if it's not the "Free" link
                            if (!aText.startsWith('Free')) {
                                regionLinks.push({ text: aText, url: fullUrl });
                            }
                        });
                        console.log(); // Add a blank line for readability
                    }
                });

                // Step 4: Process each region link
                for (const regionLink of regionLinks) {
                    console.log(clc.blue(`\n🌎 Processing region: ${regionLink.text}`));
                    try {
                        const regionResponse = await axios.get(regionLink.url, { httpsAgent });
                        const region$ = cheerio.load(regionResponse.data);

                        // Find all tables
                        const tables = region$('table').get().reverse();

                        // Find the first table from the bottom that meets all criteria
                        const targetTable = tables.find(table => {
                            const $table = region$(table);
                            const rowCount = $table.find('td').length;
                            const tableText = $table.text();
                            const hasAdvert = $table.find('a[href*="advert"]').length > 0;
                            const hasIElement = $table.find('i').length > 0;
                            const hasScriptTag = $table.find('script').length > 0;

                            return rowCount > 4 &&
                                !tableText.includes('Advertisements') &&
                                !tableText.includes('News at') &&
                                !hasAdvert &&
                                !hasIElement &&
                                !hasScriptTag;
                        });

                        if (targetTable) {
                            console.log(clc.green(`   📊 Found suitable table with ${region$(targetTable).find('td').length} country rows`));

                            // Log table content and extract anchor links
                            const countryLinks = [];
                            region$(targetTable).find('tr').each((rowIndex, row) => {
                                const $row = region$(row);
                                const rowContent = $row.find('td').map((_, cell) => region$(cell).text().trim()).get().join(' | ');
                                console.log(clc.white(`      ${rowContent}`));

                                // Extract anchor links
                                $row.find('a').each((_, anchor) => {
                                    const $anchor = region$(anchor);
                                    const href = $anchor.attr('href');
                                    const text = $anchor.text().trim();
                                    if (href && text.trim()) {
                                        const countryUrl = url.resolve(regionLink.url, href);
                                        countryLinks.push({ text, url: countryUrl });
                                    }
                                });
                            });

                            // Process each country link
                            for (const countryLink of countryLinks) {
                                console.log(clc.cyan(`         🔗 Country Link: ${countryLink.text} - ${countryLink.url}`));

                                // Visit the country link and extract channel information
                                try {
                                    const response = await axios.get(countryLink.url, { httpsAgent });
                                    const $ = cheerio.load(response.data);

                                    // Find the table that contains "Channel Name" and "Position"
                                    const targetTable = $('table').filter(function () {
                                        return $(this).text().includes('Channel Name') && $(this).text().includes('Position');
                                    }).first();

                                    if (targetTable.length) {
                                        console.log(clc.green(`      📡 Channel information for ${countryLink.url}:`));

                                        // Extract and log the information from each row
                                        targetTable.find('tr').each((index, row) => {
                                            if (index === 0) return; // Skip the header row

                                            const $row = $(row);
                                            const channelName = $row.find('td:nth-child(2)').text().trim();
                                            const position = $row.find('td:nth-child(3)').text().trim();
                                            const satellite = $row.find('td:nth-child(4)').text().trim();
                                            const beam = $row.find('td:nth-child(5)').text().trim();

                                            console.log(clc.white(`         Channel: ${channelName}`));
                                            console.log(clc.white(`         Position: ${position}`));
                                            console.log(clc.white(`         Satellite: ${satellite}`));
                                            console.log(clc.white(`         Beam: ${beam}`));
                                            console.log(clc.white(`         ---`));
                                        });
                                    } else {
                                        console.log(clc.yellow(`      ⚠️ No channel information table found for ${countryLink.url}`));
                                    }
                                } catch (error) {
                                    console.error(clc.red(`      ❌ Error fetching channel information for ${countryLink.url}: ${error.message}`));
                                }
                            }
                        } else {
                            console.log(clc.yellow(`   ⚠️ No suitable table found for ${regionLink.text}`));
                        }
                    } catch (error) {
                        console.error(clc.red(`   ❌ Error processing ${regionLink.text}: ${error.message}`));
                    }
                }
            } else {
                console.log(clc.yellow(`⚠️ No Free TV URL found on ${baseUrl}\n`));
            }
        } catch (error) {
            console.error(clc.red(`\n❌ Error processing ${baseUrl}: ${error.message}\n`));
        }

        console.log(clc.cyan(`✅ Finished processing ${baseUrl}\n`));
        console.log(clc.blackBright('---------------------------------------------------'));
    }
}




async function main() {
    const host = 'http://www.lyngsat.com';
    const fromDate = '20000101';  // Start date: January 1, 2000
    const toDate = new Date().toISOString().slice(0, 10).replace(/-/g, '');  // End date: Today
    const outputFileName = path.join(__dirname, 'wayback_urls.json');


    try {
        await fs.access(outputFileName);
        console.log(clc.green('📁 Wayback URLs file already exists. Reading from file...\n'));
    } catch (error) {
        console.log(clc.yellow('📁 Wayback URLs file not found. Fetching archived URLs...\n'));
        await fetchArchivedUrlsForEachMonth(host, fromDate, toDate);
    }

    try {
        const fileContent = await fs.readFile(outputFileName, 'utf8');
        let urlsObject = JSON.parse(fileContent);
        let urls = Object.values(urlsObject);

        console.log(clc.cyan(`\n🔎 Processing ${urls.length} URLs...\n`));
        await fetchAndLogFreeTVLinks(urls);
    } catch (error) {
        console.error(clc.red('\n❌ Error reading or parsing the JSON file:'), error);
    }

    console.log(clc.green('\n✅ Script execution completed.\n'));
}

main().catch(error => {
    console.error(clc.red('\n❌ An error occurred:'), error);
    process.exit(1);
});