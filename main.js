
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


async function fetchPage(url) {
    const response = await axiosInstance.get(url);
    requestCount++;
    console.log(clc.blackBright(`Requests sent: ${requestCount}`));
    return cheerio.load(response.data);
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
    } catch (error) {
        console.error(clc.red(`   ❌ Error processing ${regionUrl}: ${error.message}`));
        throw error;
    }

    return countryLinks;
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

        console.log(columnNames);

        async function processChannelRow(row) {
            let channelData = {};

            function processCells($row, offset) {
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
                                    channelData[columnName].text += `, ${text}`;
                                    channelData[columnName].url = fullUrl;
                                } else {
                                    channelData[columnName] = {
                                        text: `${channelData[columnName]}, ${text}`,
                                        url: fullUrl
                                    };
                                }
                            } else {
                                channelData[columnName] = text ? { text, url: fullUrl } : fullUrl;

                                if (fullUrl.includes("//www.lyngsat.com/tvchannels")) {
                                    channelData.channel_page = fullUrl;
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

            const $row = country$(row);
            const cellCount = $row.find('td').length;
            
            if (cellCount < columnNames.length) {
                // Continuation row
                processCells($row, columnNames.length - cellCount);
            } else {
                // New row
                processCells($row, 0);
            }

            if (channelData.channel_page && channelData.channel_page.includes("//www.lyngsat.com/tvchannels")) {
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

            // Fix for [object Object] issue
            Object.keys(channelData).forEach(key => {
                if (typeof channelData[key] === 'object' && channelData[key] !== null && key !== 'additional_data') {
                    channelData[key] = channelData[key].hasOwnProperty('text') ? channelData[key].text : JSON.stringify(channelData[key]);
                }
            });

            console.log(clc.white(`         ${JSON.stringify(channelData)}`));
            return channelData;
        }

        const channels = await Promise.all(
            channelTable.find('tr:not(:first-child)').map(async (_, row) => processChannelRow(row)).get()
        );

        return channels;

    } catch (error) {
        console.error(clc.red(`      ❌ Error extracting channel data for ${countryUrl}: ${error.message}`));
        throw error;
    }
}

async function extractChannelDataFromChannelPage({ channelPageUrl }) {
    try {
        const $ = await fetchPage(channelPageUrl);
        const channelTable = $('table').filter((_, table) => {
            const tableText = $(table).text();
            return tableText.includes('Position') && tableText.includes('Satellite') &&
                !tableText.includes('Colour legend') && !tableText.includes('News at');
        }).first();

        if (!channelTable.length) {
            console.log(clc.yellow(`      ⚠️ No channel information table found for ${channelPageUrl}`));
            return null;
        }

        const rows = channelTable.find('tr');
        rows.each((_, row) => {
            const cellsWithText = $(row).find('td').filter((_, cell) => $(cell).text().trim() !== '');
            if (cellsWithText.length <= 2) {
                $(row).remove();
            }
        });

        const columnNames = channelTable.find('tr').first().find('td').map((_, cell) =>
            $(cell).text().trim().replace(/\s+/g, ' ') || `Empty ${_}`
        ).get();

        const channelPageData = channelTable.find('tr').slice(1).map((_, row) => {
            const rowData = {};
            $(row).find('td').each((index, cell) => {
                rowData[columnNames[index]] = extractText($(cell));
            });
            return rowData;
        }).get();

        return channelPageData;
    } catch (error) {
        console.error(clc.red(`      ❌ Error fetching additional channel information from ${channelPageUrl}: ${error.message}`));
        return { error: error.message };
    }
}
function extractText($element) {
    // Replace <br> elements with spaces
    $element.find('br').replaceWith(' ');
    
    // Use Cheerio's text() method to extract text content, ignoring HTML tags
    let text = $element.text();
    
    // Replace non-breaking spaces with regular spaces
    text = text.replace(/\u00a0/g, ' ');
    
    // Replace multiple spaces with a single space
    text = text.replace(/\s+/g, ' ');
    
    // Trim leading and trailing whitespace
    text = text.trim();
    
    return text;
}


async function scrapeLyngsatArchivedWebsite(archiveUrl) {
    const hostname = new URL(archiveUrl).hostname;
    console.log(clc.cyan(`\n🔍 Processing archive URL: ${archiveUrl}\n`));

    const data = { [hostname]: { archiveUrl, regions: [] } };

    try {
        const freeTvUrl = await getFreeTVUrl({ archiveUrl });
        if (!freeTvUrl) {
            data[hostname].freeTvUrl = null;
            return;
        }

        data[hostname].freeTvUrl = freeTvUrl;

        const regionLinks = await getRegionLinks({ freeTvUrl });

        const queue = new PQueue({ concurrency: 30 });

        await queue.addAll(regionLinks.slice(0, 2).map(regionLink => async () => {
            const regionData = { name: regionLink.text, url: regionLink.url, countries: [] };

            try {
                const countryLinks = await extractCountryLinks(regionLink.url);

                await Promise.all(countryLinks.slice(0, 1).map(async countryLink => {
                    console.log(clc.cyan(`         🔗 Country Link: ${countryLink.text} - ${countryLink.url}`));
                    const countryData = { name: countryLink.text, url: countryLink.url, channels: [] };

                    try {
                        // Use the refactored function here
                        const channels = await extractChannelsDataFromCountryPage({country : countryLink});
                        countryData.channels = channels;
                    } catch (error) {
                        console.error(clc.red(`      ❌ Error fetching channel information for ${countryLink.url}: ${error.message}`));
                        countryData.error = error.message;
                    }

                    regionData.countries.push(countryData);
                }));
            } catch (error) {
                console.error(clc.red(`   ❌ Error processing ${regionLink.text}: ${error.message}`));
                regionData.error = error.message;
            }

            data[hostname].regions.push(regionData);
        }));
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
  //const channelsData = await extractChannelsDataFromCountryPage({country : {url: 'http://web.archive.org/web/20010614160931/http://www.lyngsat.com/free/China.shtml', text : 'Maldives'}});
 //  const channelsData = await extractChannelsDataFromCountryPage({country : {url: 'http://web.archive.org/web/20010118223900/http://www2.lyngsat.com:80/free/Maldives.shtml', text : 'Maldives'}});
    const channelsData = await extractChannelsDataFromCountryPage({country : {url: 'http://web.archive.org/web/20160729231814/http://www.lyngsat.com/freetv/Australia.html', text : 'Maldives'}});

return
    const freeTvUrl = await getFreeTVUrl({ archiveUrl: 'http://web.archive.org/web/20000229043304/http://www2.lyngsat.com:80/' });
    const regionLinks = await getRegionLinks({ freeTvUrl });

    const countryLinks = await extractCountryLinks({ regionUrl: regionLinks[1].url });
    const randomCountryLink = countryLinks[Math.floor(Math.random() * countryLinks.length)];

    //const channelsData = await extractChannelsDataFromCountryPage({country : randomCountryLink});
  
  //  const countryLinks = await extractCountryLinks({ regionUrl: 'http://web.archive.org/web/20240227140800/https://www.lyngsat.com/freetv/Australia.html' });



    return
    try {
        await fs.access(outputFileName);
        console.log(clc.green('📁 Wayback URLs file already exists. Reading from file...\n'));
    } catch (error) {
        console.log(clc.yellow('📁 Wayback URLs file not found. Fetching archived URLs...\n'));
        await fetchArchivedUrlsForEachMonth(host, fromDate, toDate);
    }
    return
    try {
        const fileContent = await fs.readFile(outputFileName, 'utf8');
        let urlsObject = JSON.parse(fileContent);
        let urls = Object.values(urlsObject);

        console.log(clc.cyan(`\n🔎 Processing ${urls.length} URLs...\n`));
        for (const archiveUrl of urls) {

            await scrapeLyngsatArchivedWebsite(archiveUrl);
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