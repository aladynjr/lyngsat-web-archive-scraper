
const fs = require('fs').promises;
const path = require('path');
const url = require('url');
const cheerio = require('cheerio');
const clc = require('cli-color');
require('dotenv').config();
const HttpsProxyAgent = require('https-proxy-agent');
const { default: PQueue } = require('p-queue');
const axios = require('axios');
const axiosRetry = require('axios-retry').default;
var Bottleneck = require("bottleneck/es5");


async function isArchiveSufficientlyProcessed(hostname) {
    const dataFolder = path.join(__dirname, 'data');
    const filePath = path.join(dataFolder, `${hostname}.json`);

    try {
        const fileContent = await fs.readFile(filePath, 'utf8');
        const data = JSON.parse(fileContent);
        const archiveData = data[hostname];

        if (archiveData.totalCountries > 50) {
            const errorPercentage = (archiveData.errorCount / archiveData.totalRequests) * 100;
            if (errorPercentage < 20) {
                return true;
            }
        }
    } catch (error) {
        // File doesn't exist or couldn't be read, so it hasn't been processed
        return false;
    }

    return false;
}


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
        // collapse: "timestamp:6"   // 1 capture per month
        collapse: "timestamp:4"   // 1 capture per month
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
    timeout: 15000,
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

// Set up Bottleneck
const limiter = new Bottleneck({
    maxConcurrent: 40, // 5 concurrent requests
});


// Wrap the Axios instance with the rate limiter
const limitedGet = limiter.wrap(axiosInstance.get.bind(axiosInstance));
const limitedPost = limiter.wrap(axiosInstance.post.bind(axiosInstance));
const limitedAxios = {
    get: limitedGet,
    post: limitedPost,
    // You can add other methods if needed
};


let requestCount = 0; // Initialize request count


async function fetchPage(url) {
    try {
        const response = await limitedAxios.get(url);
        requestCount++;
        const dataSizeKB = Buffer.byteLength(response.data, 'utf8') / 1024;
        console.log(clc.blackBright(`Requests sent: ${requestCount}, Response size: ${dataSizeKB.toFixed(2)} KB`));
        return cheerio.load(response.data);
    } catch (error) {
        console.error(clc.red(`Error fetching ${url}:`), error.message);
        throw error;
    }
}


async function getFreeTVUrl({ archiveUrl }) {
    try {
        const $ = await fetchPage(archiveUrl);
        const freeTvLink = $('a').toArray().find(link => {
            const $link = $(link);
            const text = $link.text().trim();
            const href = $link.attr('href') || '';
            return text.includes('Free TV') && href.includes('free') && href.includes('index');
        });

        if (!freeTvLink) {
            console.log(clc.yellow(`⚠️ No Free TV URL found on ${archiveUrl}\n`));
            return null;
        }

        const freeTvUrl = url.resolve(archiveUrl, $(freeTvLink).attr('href'));
        console.log(clc.green(`📺 Found Free TV URL: ${freeTvUrl}\n`));
        return freeTvUrl;
    } catch (error) {
        console.error(`❌ Error processing ${archiveUrl}: ${error.message}`);
        return null;
    }
}

async function getRegionLinks({ freeTvUrl }) {
    try {
        const freeTv$ = await fetchPage(freeTvUrl);

        const regionLinks = freeTv$('b').map((_, bElement) => {
            const $bElement = freeTv$(bElement);
            const aElements = $bElement.find('a');
            const bTextWithoutAnchors = $bElement.clone().children().remove().end().text().trim();
            const isFreePresentInB = bTextWithoutAnchors.includes('Free');
            const isFreePresentInFirstAnchor = aElements.length > 0 && freeTv$(aElements[0]).text().trim().startsWith('Free');

            if (aElements.length > 0 && (isFreePresentInB || isFreePresentInFirstAnchor)) {
                console.log(clc.yellow(`📌 Found Region links: ${$bElement.text().trim().replace(/\s+/g, ' ')}`));
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

        return regionLinks;
    } catch (error) {
        console.error(clc.red(`❌ Error fetching region links from ${freeTvUrl}: ${error.message}`));
        return [];
    }
}

async function extractCountryLinks({ regionUrl }) {
    console.log(clc.blue(`\n🌎 Processing region: ${regionUrl}`));
    const countryLinks = [];
    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const region$ = await fetchPage(regionUrl);

            const targetTable = region$('table').get().reverse().find(table => {
                const $table = region$(table);
                return $table.find('td').length > 4 &&
                    !$table.text().includes('Advertisements') &&
                    !$table.text().includes('News at') &&
                    !$table.find('a[href*="advert"]').length &&
                    !$table.find('i').length &&
                    !$table.find('script').length;
            });
            let rowContent = '';
            if (targetTable) {
                console.log(clc.green(`   📊 Found countries table `));

                region$(targetTable).find('tr').each((_, row) => {
                    const $row = region$(row);
                    rowContent += ' | ' + $row.find('td').map((_, cell) => {
                        const cellText = region$(cell).text().trim();
                        return cellText ? cellText : null;
                    }).get().filter(Boolean).join(' | ');

                    $row.find('a').each((_, anchor) => {
                        const $anchor = region$(anchor);
                        const href = $anchor.attr('href');
                        const text = $anchor.text().trim();
                        if (href && text.trim()) {
                            countryLinks.push({ text, url: url.resolve(regionUrl, href) });
                        }
                    });
                });

                console.log(clc.cyan(`   Found ${countryLinks.length} country links for ${clc.white(`${rowContent.trim()}`)}`));
            } else {
                console.log(clc.yellow(`   ⚠️ No suitable table found for ${regionUrl}`));
            }

            return countryLinks; // Success, exit the retry loop
        } catch (error) {
            console.error(clc.red(`   ❌ Error processing ${regionUrl} (Attempt ${attempt}/${maxRetries}): ${error.message}`));
            if (attempt === maxRetries) {
                throw error; // Throw error after all retries are exhausted
            }
            await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second before retrying
        }
    }
}


async function extractChannelsDataFromCountryPage({ country }) {
    const countryUrl = country.url;
    const countryName = country.text;
    console.log(clc.cyan(`      🔗 Processing country page: ${countryName} |  ${countryUrl}`));

    try {
        const country$ = await fetchPage(countryUrl);

        const channelTable = country$('table').filter(function () {
            const tableText = country$(this).text();
            return tableText.includes('Channel Name') &&
                tableText.includes('Logo') &&
                !tableText.includes('Advertising') &&
                !tableText.includes('Advertisements') &&
                !tableText.includes('News at');
        }).first();

        if (!channelTable.length) {
            console.log(clc.yellow(`      ⚠️ No channel information table found for ${countryUrl}`));
            return [];
        }

        console.log(clc.green(`      📡 Found channel information table for ${countryUrl}`));

        const columnNames = channelTable.find('tr:first-child td').map((index, cell) => {
            const text = country$(cell).text().trim();
            return text === '' ? (index === 1 ? 'Sat link' : `Empty ${index + 1}`) : text;
        }).get();

        
        console.log(columnNames)
        if (columnNames.length === 0) {
            throw new Error(`No columns found in the channel information table for ${countryUrl}`);
        }

        async function processChannelData(channelData) {
            if (channelData.channel_page && channelData.channel_page.includes("lyngsat.com/tvchannels")) {
                const additionalData = await extractChannelDataFromChannelPage({ channelPageUrl: channelData.channel_page });
                if (additionalData && Object.keys(additionalData).length > 0) {
                    channelData.additional_data = additionalData;
                }

                // Remove unnecessary columns if `channel_page` is present
                Object.keys(channelData).forEach(key => {
                    if (!['Logo', 'Channel Name', 'channel_page', 'additional_data'].includes(key)) {
                        delete channelData[key];
                    }
                });
                console.log(clc.green(`      ➕ Additional channel information from ${channelData.channel_page}:`));
            }

            Object.keys(channelData).forEach(key => {
               if (typeof channelData[key] === 'object' && channelData[key] !== null && key !== 'additional_data') {
                   if (key === 'Channel Name' && 'text' in channelData[key]) {
                       channelData[key] = channelData[key].text;
                   } else {
                       const objectKeys = Object.keys(channelData[key]);
                       objectKeys.forEach(objectKey => {
                           const newKey = `${key} ${objectKey}`;
                           const newValue = channelData[key][objectKey];
                           channelData[newKey] = newValue;
                       });
                       delete channelData[key];
                   }
               }
            });

            console.log(clc.white(`        ${JSON.stringify(channelData)}`));
            return channelData;
        }

        function processCells($row, offset, channelData) {
            $row.find('td').each((index, cell) => {
                const $cell = country$(cell);
                const text = extractText($cell);
                const $anchor = $cell.find('a');
                const columnName = columnNames[offset + index] || `Column ${offset + index + 1}`;

                if ($anchor.length) {
                    const href = $anchor.attr('href');
                    const fullUrl = url.resolve(countryUrl, href);
                    if (text || fullUrl) {
                        if (channelData[columnName]) {
                            if (typeof channelData[columnName] === 'object') {
                                channelData[columnName].text += text ? `, ${text}` : '';
                                channelData[columnName].url = channelData[columnName].url ? `${channelData[columnName].url}, ${fullUrl}` : fullUrl;
                            } else {
                                channelData[columnName] = {
                                    text: text ? `${channelData[columnName]}, ${text}` : channelData[columnName],
                                    url: fullUrl
                                };
                            }
                        } else {
                            channelData[columnName] = text ? { text, url: fullUrl } : { url: fullUrl };
                        }

                        // Set the correct channel_page if the column is 'Channel Name'
                        if (columnName === 'Channel Name') {
                            if (!fullUrl.includes('web.archive.org')) {
                                const countryUrlParts = countryUrl.split('/');
                                const archiveBase = countryUrlParts.slice(0, 6).join('/') + '/';
                                const fullUrlPath = new URL(fullUrl).pathname;
                                channelData.channel_page = archiveBase + '/www.lyngsat.com' + fullUrlPath;
                            } else {
                                const fullUrlParts = fullUrl.split('/');
                                if (!fullUrlParts.includes('www.lyngsat.com')) {
                                    const archiveBase = fullUrlParts.slice(0, 6).join('/') + '/';
                                    const fullUrlPath = fullUrlParts.slice(6).join('/');
                                    channelData.channel_page = archiveBase + 'www.lyngsat.com/' + fullUrlPath;
                                } else {
                                    channelData.channel_page = fullUrl;
                                }
                            }
                        }
                    }
                } else if (text) {
                    if (channelData[columnName]) {
                        if (typeof channelData[columnName] === 'object') {
                            channelData[columnName].text += `, ${text}`;
                        } else {
                            channelData[columnName] += `, ${text}`;
                        }
                    } else {
                        channelData[columnName] = text;
                    }
                }
            });
        }

        const rows = channelTable.find('tr:not(:first-child)').toArray();
        console.log(clc.cyan(`Found ${rows.length} rows in the channel table.`));

        const channels = [];
        const channelPromises = [];
        let currentChannelData = {};

        for (const row of rows) {
            const $row = country$(row);
            const cellCount = $row.find('td').length;
            const rowText = $row.text().trim();

            if (rowText === "LyngSat Stream") {
                console.log(clc.yellow(`Ignoring row with text: ${rowText}`));
                continue;
            }

            if (cellCount < columnNames.length) {
                // Continuation row
                processCells($row, columnNames.length - cellCount, currentChannelData);
            } else {
                // New row
                if (Object.keys(currentChannelData).length > 0) {
                    channelPromises.push(processChannelData(currentChannelData)); // Collect promises
                }
                currentChannelData = {};
                processCells($row, 0, currentChannelData);
            }
        }

        // Process the last channel data if exists
        if (Object.keys(currentChannelData).length > 0) {
            channelPromises.push(processChannelData(currentChannelData)); // Collect promises
        }

        // Wait for all promises to resolve
        const resolvedChannels = await Promise.all(channelPromises);
        channels.push(...resolvedChannels);

        // Filter channels with 'Channel Name'
        const filteredChannels = channels.filter(channel => channel['Channel Name']);

        const missingNameChannels = filteredChannels.filter(channel => !channel['Channel Name']);
        if (missingNameChannels.length > 0) {
            const errorMessage = `Found ${missingNameChannels.length} channels without 'Channel Name' for ${countryUrl}`;
            console.error(clc.red(`      ❌ ${errorMessage}`));
            errors.push({ url: countryUrl, error: errorMessage });
        }

        const outputFilePath = path.join(__dirname, 'test.json');
        const outputData = JSON.stringify(filteredChannels, null, 2);
       await fs.writeFile(outputFilePath, outputData, 'utf8');
       console.log(clc.green(`Channels data saved to ${outputFilePath}`));
        return filteredChannels;

    } catch (error) {
        console.error(clc.red(`      ❌ Error extracting channel data for ${countryUrl}: ${error.message}`));
        throw error;
    }
}


async function extractChannelDataFromChannelPage({ channelPageUrl }) {
    const maxRetries = 3;
    let retries = 0;

    while (retries < maxRetries) {
        try {
            const $ = await fetchPage(channelPageUrl);
            const channelTable = $('table').filter((_, table) => {
                const tableText = $(table).text();
                const tableHtml = $(table).html();
                return tableText.includes('Position') && tableText.includes('Satellite') &&
                    !tableText.includes('Colour legend') && !tableText.includes('News at') &&
                    !tableText.includes('google_ad') && !tableText.includes('Advertisements') &&
                    !tableHtml.includes('window.adsbygoogle');
            }).first();

            if (!channelTable.length) {
                throw new Error('No channel information table found');
            }

            const rows = channelTable.find('tr');
            rows.each((_, row) => {
                const cellsWithText = $(row).find('td').filter((_, cell) => $(cell).text().trim() !== '');
                if (cellsWithText.length <= 2 || $(row).text().includes('lyngsat.com')) {
                    $(row).remove();
                }
            });

            const columnNames = channelTable.find('tr').first().find('td').map((_, cell) =>
                $(cell).text().trim().replace(/\s+/g, ' ') || `Empty ${_}`
            ).get();
            console.log('Columns: ' + columnNames.join(', '));
            if (columnNames.length === 0) {
                throw new Error('No column names found in the channel information table');
            }

            const channelPageData = channelTable.find('tr').slice(1).map((_, row) => {
                const rowData = {};
                $(row).find('td').each((index, cell) => {
                    const $cell = $(cell);
                    const $anchor = $cell.find('a');
                    if ($anchor.length) {
                        rowData[`${columnNames[index]} text`] = $anchor.text().trim();
                        rowData[`${columnNames[index]} url`] = $anchor.attr('href');
                    } else {
                        rowData[columnNames[index]] = extractText($cell);
                    }
                });
                return rowData;
            }).get();

            if (channelPageData.length === 0) {
                throw new Error('No data found in the channel information table');
            }

            return channelPageData;
        } catch (error) {
            retries++;
            if (retries >= maxRetries) {
                console.error(clc.red(`      ❌ Error fetching additional channel information from ${channelPageUrl} after ${maxRetries} attempts: ${error.message}`));
                errors.push({ url: channelPageUrl, error: error.message });
                return { error: error.message };
            }
            console.log(clc.yellow(`      ⚠️ Attempt ${retries} in scraping channel page failed. Retrying...`));
            await new Promise(resolve => setTimeout(resolve, 1000 * retries)); // Exponential backoff
        }
    }
}


function extractText($element) {
    $element.find('br').replaceWith(' ');

    let text = $element.text();

    text = text.replace(/\u00a0/g, ' ');

    text = text.replace(/\s+/g, ' ');

    text = text.trim();

    return text;
}





let totalCountries = 0;
let totalChannels = 0;
let errorCount = 0;
let errors = [];
let totalErrors = []
let TEST_MODE = true
async function scrapeLyngsatArchivedWebsite(archiveUrl) {
    const startTime = Date.now();
    const hostname = archiveUrl.match(/\/web\/(\d{14})/)[1];
    console.log(clc.cyan(`\n🔍 Processing archive URL: ${archiveUrl}\n`));
    const data = { [hostname]: { archiveUrl, regions: [] } };

    try {
        let freeTvUrl;
        let attempts = 0;
        const maxAttempts = 3;

        while (!freeTvUrl && attempts < maxAttempts) {
            freeTvUrl = await getFreeTVUrl({ archiveUrl });
            attempts++;

            if (!freeTvUrl && attempts < maxAttempts) {
                console.log(clc.yellow(`⚠️ Attempt ${attempts} failed. Retrying...`));
                await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second before retrying
            }
        }

        if (!freeTvUrl) {
            console.log(clc.yellow(`⚠️ No Free TV URL found for ${archiveUrl} after ${maxAttempts} attempts`));
            data[hostname].freeTvUrl = null;
            return;
        }

        data[hostname].freeTvUrl = freeTvUrl;

        const regionLinks = await getRegionLinks({ freeTvUrl });

        const queue = new PQueue({ concurrency: 1000 });

        await queue.addAll((TEST_MODE ? regionLinks.slice(0, 2) : regionLinks).map(regionLink => async () => {
            const regionData = { name: regionLink.text, url: regionLink.url, countries: [] };

            try {
                const countryLinks = await extractCountryLinks({ regionUrl: regionLink.url });

                await Promise.all((TEST_MODE ? countryLinks.slice(0, 10) : countryLinks).map(async countryLink => {
                    console.log(clc.cyan(`         🔗 Country Link: ${countryLink.text} - ${countryLink.url}`));
                    const countryData = { name: countryLink.text, url: countryLink.url, channels: [] };

                    try {
                        const channels = await extractChannelsDataFromCountryPage({ country: countryLink });
                        //console.log(channels)
                        countryData.channels = channels;
                        totalCountries++;
                        totalChannels += channels.length;
                    } catch (error) {
                        console.error(clc.red(`      ❌ Error fetching channel information for ${countryLink.url}: ${error.message}`));
                        countryData.error = error.message;
                        errors.push({ url: countryLink.url, error: error.message });
                        errorCount++;
                    }

                    regionData.countries.push(countryData);
                }));
            } catch (error) {
                console.error(clc.red(`   ❌ Error processing ${regionLink.text}: ${error.message}`));
                regionData.error = error.message;
                errorCount++;
            }

            data[hostname].regions.push(regionData);
        }));
    } catch (error) {
        console.error(clc.red(`\n❌ Error processing ${archiveUrl}: ${error.message}\n`));
        data[hostname].error = error.message;
        errorCount++;
        errors.push({ url: archiveUrl, error: error.message });
    }

    const endTime = Date.now();
    const executionTime = (endTime - startTime) / 1000; // Convert to seconds

    // Add the new fields to the result
    data[hostname].totalCountries = totalCountries;
    data[hostname].totalChannels = totalChannels;
    data[hostname].errorCount = errorCount;
    data[hostname].totalRequests = requestCount;
    data[hostname].executionTimeSeconds = executionTime;
    data[hostname].errors = errors;

    console.log(clc.cyan(`✅ Finished processing ${archiveUrl}\n`));
    const outputData = JSON.stringify(data, null, 2);
    const dataFolder = path.join(__dirname, 'data');
    await fs.mkdir(dataFolder, { recursive: true });
    
    // Extract year and month from hostname
    const [year, month] = hostname.slice(0, 6).match(/.{1,4}/g);
    const monthName = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][parseInt(month, 10) - 1];
    
    // Create the new filename format
    const newFilename = `${year}-${monthName}_${hostname}.json`;
    const outputPath = path.join(dataFolder, newFilename);
    
    try {
        await fs.writeFile(outputPath, outputData);
        console.log(clc.green(`✅ Data saved successfully to ${outputPath}`));
    } catch (error) {
        console.error(clc.red(`❌ Error saving data to file: ${error.message}`));
    } finally {
        // Reset request count
        requestCount = 0;
    }
    console.log(clc.blackBright('---------------------------------------------------'));
}










async function main() {
    const host = 'http://www.lyngsat.com';
    const fromDate = '20000101';  // Start date: January 1, 2000
    const toDate = new Date().toISOString().slice(0, 10).replace(/-/g, '');  // End date: Today
    const outputFileName = path.join(__dirname, 'wayback_urls.json');


    /*
    const startTime = Date.now();
    const channelsData = await extractChannelsDataFromCountryPage({country : {url: 'http://web.archive.org/web/20141220192121/http://www.lyngsat.com/freetv/Australia.html', text : 'Australia'}});
    const endTime = Date.now();
    console.log(`Execution time: ${((endTime - startTime) / 1000 / 60).toFixed(2)} minutes`);
    return
  //const channelsData = await extractChannelsDataFromCountryPage({country : {url: 'http://web.archive.org/web/20010614160931/http://www.lyngsat.com/free/China.shtml', text : 'Maldives'}});
    const channelsData = await extractChannelsDataFromCountryPage({country : {url: 'http://web.archive.org/web/20160729231814/http://www.lyngsat.com/freetv/Australia.html', text : 'Maldives'}});

return
    const freeTvUrl = await getFreeTVUrl({ archiveUrl: 'http://web.archive.org/web/20000229043304/http://www2.lyngsat.com:80/' });
    const regionLinks = await getRegionLinks({ freeTvUrl });

    const countryLinks = await extractCountryLinks({ regionUrl: regionLinks[1].url });
    const randomCountryLink = countryLinks[Math.floor(Math.random() * countryLinks.length)];

    
    //  const countryLinks = await extractCountryLinks({ regionUrl: 'http://web.archive.org/web/20240227140800/https://www.lyngsat.com/freetv/Australia.html' });
    //const channelsData = await extractChannelsDataFromCountryPage({country : randomCountryLink});

    return
    
    
    await extractChannelDataFromChannelPage({ channelPageUrl: 'http://web.archive.org/web/20141217120151/http://www.lyngsat.com/tvchannels/id/TVRI-Nasional.html' })
    return
    const channelsData = await extractChannelsDataFromCountryPage({ country: { url: 'http://web.archive.org/web/20141220192121/http://www.lyngsat.com/freetv/Brunei.html', text: "Brunei" } });
 
    
        const channelsData = await extractChannelsDataFromCountryPage({ country: { url: 'http://web.archive.org/web/20210421135838/http://www.lyngsat.com/freetv/Japan.html', text: "Japan" } });
    
    
    
    const channelsData = await extractChannelsDataFromCountryPage({ country: { url: 'http://web.archive.org/web/20080831093046/http://www.lyngsat.com/freetv/Japan.html', text: "Japan" } });
      return
    */


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
            const hostname = archiveUrl.match(/\/web\/(\d{14})/)[1];

            if (await isArchiveSufficientlyProcessed(hostname)) {
                console.log(clc.yellow(`Skipping ${archiveUrl} as it has been sufficiently processed.`));
                continue;
            }

            const startTime = Date.now();
            await scrapeLyngsatArchivedWebsite(archiveUrl);
            const endTime = Date.now();

            if (errors.length > 0) {
                console.log(clc.red('\n❌ Errors encountered during execution:'));
                errors.forEach((err, index) => {
                    console.log(clc.red(`${index + 1}. URL: ${err.url}`));
                    console.log(clc.red(`   Error: ${err.error}`));
                });
            } else {
                console.log(clc.green('\n✅ No errors encountered during execution.'));
            }

            console.log(`Execution time: ${((endTime - startTime) / 1000 / 60).toFixed(2)} minutes`);
            console.log('##########################################################################');
            console.log('##########################################################################');

            // Add errors to totalErrors before resetting
            totalErrors = totalErrors.concat(errors);
            // Reset errors after processing each URL
            errors = [];
        }
    } catch (error) {
        console.error(clc.red('\n❌ Error reading or parsing the JSON file:'), error);
    }

console.log(totalErrors)
    console.log(clc.green('\n✅ Script execution completed.\n'));
}

main().catch(error => {
    console.error(clc.red('\n❌ An error occurred:'), error);
    process.exit(1);
});