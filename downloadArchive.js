const axios = require('axios');
const axiosRetry = require('axios-retry').default;
const cheerio = require('cheerio');
const fs = require('fs-extra');
const path = require('path');
const Bottleneck = require("bottleneck/es5");
const sanitize = require("sanitize-filename");
const url = require('url');
require('dotenv').config();

const username = process.env.GEONODE_USERNAME;
const password = process.env.GEONODE_PASSWORD;
const GEONODE_DNS = process.env.GEONODE_DNS;
const GEONODE_PORT = process.env.GEONODE_PORT || 9010;

console.log('Starting script...');
console.log(`Proxy settings: DNS: ${GEONODE_DNS}, Port: ${GEONODE_PORT}`);

const axiosInstance = axios.create({
    timeout: 30000,
    proxy: {
        protocol: 'http',
        host: GEONODE_DNS,
        port: GEONODE_PORT,
        auth: {
            username,
            password,
        },
    },
    httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
});

axiosRetry(axiosInstance, {
    retries: 3,
    retryCondition: (error) => {
        console.log(`Retry condition met: ${error.message}`);
        return axiosRetry.isNetworkOrIdempotentRequestError(error) || error.code === 'ECONNABORTED' || (error.response && error.response.status >= 500);
    },
    retryDelay: (retryCount) => {
        console.log(`Retrying... Attempt ${retryCount}`);
        return retryCount * 2000;
    },
});

const limiter = new Bottleneck({
    maxConcurrent: 10,
});

const limitedGet = limiter.wrap(axiosInstance.get.bind(axiosInstance));

const baseUrl = 'http://web.archive.org/web/20150102195325/http://www.lyngsat.com/';
const baseDomain = 'web.archive.org';
const visitedUrls = new Set();
const outputFolder = path.join(__dirname, 'downloaded_content');
const maxDepth = 20;
const acceptedExtensions = ['.html', '.htm', '.shtml'];
const rejectedExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.svg', '.webp', '.css', '.js', '.json', '.xml', '.txt', '.ico', '.tiff', '.tif', '.mp3', '.mp4', '.avi', '.mov', '.mkv', '.wmv', '.flv', '.swf', '.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.exe', '.dmg', '.iso'];

function sanitizeFilePath(filePath) {
    return filePath.split(path.sep).map(part => sanitize(part)).join(path.sep);
}

function shouldDownload(normalizedUrl) {
     


    return (normalizedUrl.includes("freetv") || normalizedUrl === "index.html") && 
           !normalizedUrl.includes("advert") && 
           !normalizedUrl.includes(".php") && 
           !rejectedExtensions.some(ext => normalizedUrl.endsWith(ext));
}

function getFilename(urlString) {
    // Use a hash of the URL to create a unique filename
    const crypto = require('crypto');
    const hash = crypto.createHash('md5').update(urlString).digest('hex');
    
    // Extract the part of the URL after the last http://
    const lastHttpIndex = urlString.lastIndexOf('http://');
    let filenamePart = urlString.substring(lastHttpIndex + 7);
    
    // Remove www. and lyngsat.com/ from the filename part
    filenamePart = filenamePart.replace('www.', '').replace('lyngsat.com/', '');
    
    // Sanitize the filename part
    filenamePart = sanitize(filenamePart);
    
    // If it's a directory (ends with '/'), use 'index.html'
    if (filenamePart === '' || filenamePart.endsWith('/')) {
        filenamePart += 'index.html';
    }
    
    return `${filenamePart}-${hash}.html`;
}

function normalizeUrl(urlString) {
    const regex = /http:\/\/web\.archive\.org\/web\/\d{14}\/http:\/\/www\.lyngsat\.com\//;
    const normalizedUrl = urlString.replace(regex, '');
    return normalizedUrl || 'index.html';
}



async function fetchPage(urlString, outputPath, depth = 0) {
    const normalizedUrl = normalizeUrl(urlString);

    if (visitedUrls.has(normalizedUrl) || depth > maxDepth) {
        console.log(`Skipping ${normalizedUrl}: ${visitedUrls.has(normalizedUrl) ? 'Already visited' : 'Max depth reached'}`);
        return;
    }

    visitedUrls.add(normalizedUrl);
    console.log(`Added ${normalizedUrl} to visited URLs`);

    console.log(`Fetching ${normalizedUrl} at depth ${depth}`);

    if (!shouldDownload(normalizedUrl)) {
        console.log(`Skipping ${normalizedUrl}: Does not meet download criteria`);
        return;
    }

    try {
        console.log(`Sending request to ${urlString}`);
        const response = await limitedGet(urlString);
        console.log(`Received response from ${urlString}`);
        const $ = cheerio.load(response.data);

        // Get the filename
        const filename = getFilename(normalizedUrl);
        const filePath = path.join(outputPath, filename);

        // Ensure the directory exists
        await fs.ensureDir(path.dirname(filePath));

        // Save the file
        await fs.writeFile(filePath, response.data, 'utf-8');

        console.log(`Downloaded: ${normalizedUrl} to ${filePath}`);

        // Convert links
        $('a').each((_, element) => {
            const href = $(element).attr('href');
            if (href) {
                const absoluteUrl = new URL(href, urlString).href;
                $(element).attr('href', absoluteUrl);
            }
        });

        // Recursively download linked HTML pages
        const links = $('a').map((_, element) => $(element).attr('href')).get();
        console.log(`Found ${links.length} links on ${normalizedUrl}`);
        for (const link of links) {
            if (link) {
                const absoluteLink = new URL(link, urlString).href;
                if (!visitedUrls.has(normalizeUrl(absoluteLink))) {
                    await fetchPage(absoluteLink, outputPath, depth + 1);
                } else {
                    console.log(`Skipping ${absoluteLink}: Already visited`);
                }
            }
        }
    } catch (error) {
        console.error(`Error fetching ${normalizedUrl}:`, error.message);
    }
}

// Function to generate a unique filename
function getFilename(urlString) {
    return sanitize(urlString.replace(/[^a-z0-9]/gi, '_').toLowerCase()) + '.html';
}

// Start the process
console.log(`Starting download from ${baseUrl}`);
fetchPage(baseUrl, outputFolder)
    .then(() => {
        console.log('All pages have been downloaded');
    })
    .catch((error) => {
        console.error('An error occurred:', error);
    });

// Keep the script running
setInterval(() => {}, 1000);
