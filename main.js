
const fs = require('fs').promises;
const path = require('path');
const url = require('url');
const cheerio = require('cheerio');
const clc = require('cli-color');
require('dotenv').config();
const HttpsProxyAgent = require('https-proxy-agent');
const {default: PQueue} = require('p-queue');
const axios = require('axios');
const axiosRetry = require('axios-retry').default;




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
        const response = await axios.get(waybackApiUrl, {
            params, proxy: {
                protocol: 'http',
                host: GEONODE_DNS,
                port: GEONODE_PORT,
                auth: {
                    username,
                    password,
                },
            },
        });
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

// .env content:


const username = process.env.GEONODE_USERNAME;
const password = process.env.GEONODE_PASSWORD;
const GEONODE_DNS = process.env.GEONODE_DNS;
const GEONODE_PORT = process.env.GEONODE_PORT || 9005



const axiosInstance = axios.create({
    timeout: 10000,
    proxy: {
        protocol: 'http',
        host: GEONODE_DNS,
        port: GEONODE_PORT,
        auth: {
            username,
            password,
        },
    },
});

axiosRetry(axiosInstance, {
    retries: 3,
    retryCondition: (error) => {
        return error.code === 'ECONNABORTED' || (error.response && error.response.status >= 500);
    },
    retryDelay: (retryCount) => {
        return retryCount * 1000;
    },
});
let requestCount = 0; // Initialize request count

async function fetchAndLogFreeTVLinks(archiveUrl) {
    const data = {};
    const hostname = new URL(archiveUrl).hostname;
    console.log(clc.cyan(`\n🔍 Processing base URL: ${archiveUrl}\n`));

    data[hostname] = { archiveUrl, regions: [] };

    try {
        const response = await axiosInstance.get(archiveUrl);
        requestCount++;
        console.log(clc.blackBright(`Requests sent: ${requestCount}`));

        const $ = cheerio.load(response.data);
        const freeTvLink = $('a').toArray()
            .find(link => {
                const $link = $(link);
                const text = $link.text().trim();
                const href = $link.attr('href') || '';
                return text.includes('Free TV') && href.includes('free') && href.includes('index');
            });

        if (!freeTvLink) {
            console.log(clc.yellow(`⚠️ No Free TV URL found on ${archiveUrl}\n`));
            data[hostname].freeTvUrl = null;
            return;
        }

        const freeTvUrl = url.resolve(archiveUrl, $(freeTvLink).attr('href'));
        console.log(clc.green(`📺 Found Free TV URL: ${freeTvUrl}\n`));
        data[hostname].freeTvUrl = freeTvUrl;

        const freeTvResponse = await axiosInstance.get(freeTvUrl);
        requestCount++;
        console.log(clc.blackBright(`Requests sent: ${requestCount}`));

        const freeTv$ = cheerio.load(freeTvResponse.data);

        const regionLinks = freeTv$('b').map((_, bElement) => {
            const $bElement = freeTv$(bElement);
            const aElements = $bElement.find('a');
            const bTextWithoutAnchors = $bElement.clone().children().remove().end().text().trim();
            const isFreePresentInB = bTextWithoutAnchors.includes('Free');
            const isFreePresentInFirstAnchor = aElements.length > 0 && freeTv$(aElements[0]).text().trim().startsWith('Free');

            if (aElements.length > 0 && (isFreePresentInB || isFreePresentInFirstAnchor)) {
                console.log(clc.yellow(`📌 Found b element: ${$bElement.text().trim().replace(/\s+/g, ' ')}`));
                return aElements.map((_, aElement) => {
                    const $aElement = freeTv$(aElement);
                    const aText = $aElement.text().trim();
                    const aHref = $aElement.attr('href');
                    const fullUrl = aHref ? url.resolve(freeTvUrl, aHref) : 'N/A';
                    console.log(clc.magenta(`   🔗 Link: ${aText} - ${fullUrl}`));
                    return !aText.startsWith('Free') ? { text: aText, url: fullUrl } : null;
                }).get().filter(Boolean);
            }
            return null;
        }).get().flat().filter(Boolean);

        for (const regionLink of regionLinks) {
            console.log(clc.blue(`\n🌎 Processing region: ${regionLink.text}`));
            const regionData = { name: regionLink.text, url: regionLink.url, countries: [] };
            try {
                const regionResponse = await axiosInstance.get(regionLink.url);
                requestCount++;
                console.log(clc.blackBright(`Requests sent: ${requestCount}`));

                const region$ = cheerio.load(regionResponse.data);

                const targetTable = region$('table').get().reverse().find(table => {
                    const $table = region$(table);
                    return $table.find('td').length > 4 &&
                        !$table.text().includes('Advertisements') &&
                        !$table.text().includes('News at') &&
                        !$table.find('a[href*="advert"]').length &&
                        !$table.find('i').length &&
                        !$table.find('script').length;
                });

                if (targetTable) {
                    console.log(clc.green(`   📊 Found suitable table with ${region$(targetTable).find('td').length} country rows`));

                    const countryLinks = [];
                    region$(targetTable).find('tr').each((_, row) => {
                        const $row = region$(row);
                        const rowContent = $row.find('td').map((_, cell) => region$(cell).text().trim()).get().join(' | ');
                        console.log(clc.white(`      ${rowContent}`));

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

                    console.log(clc.cyan(`   Processing ${countryLinks.length} country links`));

                    const queue = new PQueue({ concurrency: 30 });

                    await queue.addAll(countryLinks.map(countryLink => async () => {
                        console.log(clc.cyan(`         🔗 Country Link: ${countryLink.text} - ${countryLink.url}`));
                        const countryData = { name: countryLink.text, url: countryLink.url, channels: [] };

                        try {
                            const countryResponse = await axiosInstance.get(countryLink.url);
                            requestCount++;
                            console.log(clc.blackBright(`Requests sent: ${requestCount}`));

                            const country$ = cheerio.load(countryResponse.data);

                            const channelTable = country$('table').filter(function () {
                                return country$(this).text().includes('Channel Name') && country$(this).text().includes('Logo');
                            }).first();

                            if (channelTable.length) {
                                console.log(clc.green(`      📡 Channel information for ${countryLink.url}:`));

                                const columnNames = channelTable.find('tr:first-child td').map((_, cell) => {
                                    const text = country$(cell).text().trim();
                                    return text === '' ? 'Sat link' : text;
                                }).get();

                                let prevRowData = {};
                                let mergedData = {};
                                channelTable.find('tr:not(:first-child)').each((_, row) => {
                                    const $row = country$(row);
                                    const cellCount = $row.find('td').length;

                                    if (cellCount < columnNames.length) {
                                        // This is a continuation row, merge with previous data
                                        $row.find('td').each((index, cell) => {
                                            const $cell = country$(cell);
                                            const text = $cell.text().trim();
                                            const $anchor = $cell.find('a');
                                            const columnName = columnNames[columnNames.length - cellCount + index];
                                            
                                            if ($anchor.length) {
                                                const href = $anchor.attr('href');
                                                if (typeof mergedData[columnName] === 'object') {
                                                    mergedData[columnName].text += ', ' + text;
                                                    mergedData[columnName].url = url.resolve(countryLink.url, href);
                                                } else {
                                                    mergedData[columnName] = { text, url: url.resolve(countryLink.url, href) };
                                                }
                                            } else {
                                                if (mergedData[columnName]) {
                                                    mergedData[columnName] += ', ' + text;
                                                } else {
                                                    mergedData[columnName] = text;
                                                }
                                            }
                                        });
                                    } else {
                                        // This is a new row
                                        if (Object.keys(mergedData).length > 0) {
                                            countryData.channels.push(mergedData);
                                            console.log(clc.white(`         ${JSON.stringify(mergedData)}`));
                                            mergedData = {};
                                        }

                                        $row.find('td').each((index, cell) => {
                                            const $cell = country$(cell);
                                            const text = $cell.text().trim();
                                            const $anchor = $cell.find('a');
                                            if ($anchor.length) {
                                                const href = $anchor.attr('href');
                                                mergedData[columnNames[index]] = { text, url: url.resolve(countryLink.url, href) };
                                            } else {
                                                mergedData[columnNames[index]] = text;
                                            }
                                        });
                                    }
                                });

                                if (Object.keys(mergedData).length > 0) {
                                    countryData.channels.push(mergedData);
                                    console.log(clc.white(`         ${JSON.stringify(mergedData)}`));
                                }
                            } else {
                                console.log(clc.yellow(`      ⚠️ No channel information table found for ${countryLink.url}`));
                            }
                        } catch (error) {
                            console.error(clc.red(`      ❌ Error fetching channel information for ${countryLink.url}: ${error.message}`));
                            countryData.error = error.message;
                        }

                        regionData.countries.push(countryData);
                    }));

                } else {
                    console.log(clc.yellow(`   ⚠️ No suitable table found for ${regionLink.text}`));
                }
            } catch (error) {
                console.error(clc.red(`   ❌ Error processing ${regionLink.text}: ${error.message}`));
                regionData.error = error.message;
            }

            data[hostname].regions.push(regionData);
        }
    } catch (error) {
        console.error(clc.red(`\n❌ Error processing ${archiveUrl}: ${error.message}\n`));
        data[hostname].error = error.message;
    }

    console.log(clc.cyan(`✅ Finished processing ${archiveUrl}\n`));
    const outputData = JSON.stringify(data, null, 2);
    const outputPath = path.join(__dirname, `${hostname}${new Date().toISOString().slice(0, 10)}.json`);
    
    try {
        await fs.writeFile(outputPath, outputData);
        console.log(clc.green(`✅ Data saved successfully to ${outputPath}`));
    } catch (error) {
        console.error(clc.red(`❌ Error saving data to file: ${error.message}`));
    }
    console.log(clc.blackBright('---------------------------------------------------'));
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
        for (const archiveUrl of urls) {

        await fetchAndLogFreeTVLinks(archiveUrl);
        }
    } catch (error) {
        console.error(clc.red('\n❌ Error reading or parsing the JSON file:'), error);
    }

    console.log(clc.green('\n✅ Script execution completed.\n'));
}

main().catch(error => {
    console.error(clc.red('\n❌ An error occurred:'), error);
    process.exit(1);
});