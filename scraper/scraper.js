import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import http from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEBUG = process.env.DEBUG === 'true';

const config = {
  downloadDir: path.resolve(__dirname, './downloads'),
  timeout: 60000,
  headless: !DEBUG,
};

const FILE_EXTENSIONS = [
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.zip', '.rar', '.7z', '.tar', '.gz',
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv',
  '.txt', '.csv', '.json', '.xml'
];

function extractFilename(url) {
  try {
    let decodedUrl = decodeURIComponent(url);
    const match = decodedUrl.match(/filename[=%3D]+([^&]+)/i);
    if (match) {
      let filename = match[1];
      try { filename = decodeURIComponent(filename); } catch (e) {}
      filename = filename.replace(/%28/g, '(').replace(/%29/g, ')').replace(/%20/g, ' ');
      filename = filename.replace(/[<>:"/\\|?*]/g, '_').split('&')[0];
      return filename;
    }
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split('/');
    let filename = pathParts[pathParts.length - 1];
    if (filename.match(/^[a-f0-9-]{36}$/i)) {
      const ext = url.match(/\.(pdf|doc|docx|xls|xlsx|ppt|pptx|mp3|mp4|jpg|jpeg|png|gif)/i);
      if (ext) filename = filename + ext[0];
    }
    return filename || 'unknown';
  } catch (e) {
    return 'unknown';
  }
}

function getFileType(filepath) {
  try {
    const buffer = Buffer.alloc(12);
    const fd = fs.openSync(filepath, 'r');
    fs.readSync(fd, buffer, 0, 12, 0);
    fs.closeSync(fd);

    if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) return 'pdf';
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return 'jpeg';
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return 'png';
    if (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) return 'mp3';
    if (buffer.toString('utf8', 0, 4) === 'fLaC') return 'flac';
    if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) return 'wav';
    return 'unknown';
  } catch (e) {
    return 'unknown';
  }
}

// Download file directly via HTTP/HTTPS (bypasses browser session issues)
function downloadFile(url, filepath) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(filepath);

    protocol.get(url, (response) => {
      // Handle redirects
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.close();
        fs.unlinkSync(filepath);
        return downloadFile(response.headers.location, filepath).then(resolve).catch(reject);
      }

      if (response.statusCode !== 200) {
        file.close();
        fs.unlinkSync(filepath);
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }

      const contentType = response.headers['content-type'] || '';
      response.pipe(file);

      file.on('finish', () => {
        file.close();
        resolve({ contentType });
      });
    }).on('error', (err) => {
      file.close();
      fs.unlink(filepath, () => {});
      reject(err);
    });
  });
}

async function scrapeTaskCards(page, browser, shouldDownload) {
  console.log('Detected TaskCards page, using specialized scraping...');

  await page.waitForSelector('[class*="card"], [class*="Card"]', { timeout: config.timeout })
    .catch(() => console.log('No card elements found'));
  await new Promise(r => setTimeout(r, 3000));

  // Scroll through the page to load all content
  console.log('Scrolling to load all content...');
  await page.evaluate(async () => {
    const scrollStep = 500;
    const scrollDelay = 300;
    let currentPosition = 0;
    const maxScroll = document.body.scrollHeight;

    while (currentPosition < maxScroll) {
      window.scrollTo(0, currentPosition);
      currentPosition += scrollStep;
      await new Promise(r => setTimeout(r, scrollDelay));
    }
    window.scrollTo(0, 0);
  });
  await new Promise(r => setTimeout(r, 2000));

  // Extract file info from aria-labels with positions
  const fileInfo = await page.evaluate(() => {
    const filesMap = new Map();
    document.querySelectorAll('[aria-label]').forEach(el => {
      const ariaLabel = el.getAttribute('aria-label') || '';
      const fileMatch = ariaLabel.match(/^(.+\.(pdf|mp3|doc|docx|xls|xlsx|ppt|pptx))$/i);
      if (fileMatch) {
        const filename = fileMatch[1].trim();
        const rect = el.getBoundingClientRect();
        if (!filesMap.has(filename) && rect.width > 0 && rect.height > 0) {
          filesMap.set(filename, {
            filename,
            x: rect.x + rect.width / 2,
            y: rect.y + rect.height / 2
          });
        }
      }
    });
    return Array.from(filesMap.values());
  });

  const pageData = await page.evaluate(() => ({
    title: document.title,
    cardCount: document.querySelectorAll('[class*="card"], [class*="Card"]').length
  }));

  const data = {
    title: pageData.title,
    cards: [{ text: `Found ${pageData.cardCount} cards` }],
    files: fileInfo.map(f => ({ name: f.filename, url: '' })),
    images: [],
    links: []
  };

  if (shouldDownload && fileInfo.length > 0) {
    console.log(`\nFound ${fileInfo.length} files. Attempting to extract URLs...`);

    // Try to extract file URLs from the page's data/state without clicking
    // TaskCards is a Vue app - look for data in Vue component state or data attributes
    const extractedUrls = await page.evaluate(() => {
      const urls = new Map();

      // Method 1: Look for data attributes containing URLs
      document.querySelectorAll('[data-url], [data-src], [data-file-url], [data-download-url]').forEach(el => {
        const url = el.dataset.url || el.dataset.src || el.dataset.fileUrl || el.dataset.downloadUrl;
        if (url && (url.includes('s3') || url.includes('amazonaws'))) {
          const label = el.getAttribute('aria-label') || el.title || '';
          urls.set(label || url, url);
        }
      });

      // Method 2: Look for hidden links with S3 URLs
      document.querySelectorAll('a[href*="s3"], a[href*="amazonaws"]').forEach(a => {
        const href = a.href;
        const label = a.getAttribute('aria-label') || a.title || a.innerText?.trim() || '';
        if (href && !urls.has(label)) {
          urls.set(label || href, href);
        }
      });

      // Method 3: Look for Vue component data (if accessible)
      const vueInstances = [];
      document.querySelectorAll('*').forEach(el => {
        if (el.__vue__ || el.__vueParentComponent) {
          const vm = el.__vue__ || el.__vueParentComponent?.proxy;
          if (vm && vm.$data) {
            vueInstances.push(vm.$data);
          }
        }
      });

      // Method 4: Look for img src with S3 URLs (might be thumbnails but URLs could work)
      document.querySelectorAll('img[src*="s3"], img[src*="amazonaws"]').forEach(img => {
        const src = img.src;
        const label = img.getAttribute('aria-label') || img.alt || '';
        // These are likely preview thumbnails, but capture them
        if (!urls.has(label) && src.includes('attachment')) {
          urls.set(label || src, src);
        }
      });

      // Method 5: Search entire page HTML for S3 URLs (last resort)
      const htmlContent = document.documentElement.outerHTML;
      // Match full S3 URLs with query params, being careful about boundaries
      const s3Regex = /https:\/\/[a-zA-Z0-9.-]+\.(?:s3|amazonaws)[a-zA-Z0-9./-]+\?[^"'\s<>]+/g;
      const matches = htmlContent.match(s3Regex) || [];
      matches.forEach(match => {
        // Don't clean the URL - keep it intact for signed URLs
        // Only remove trailing quotes/brackets if present
        let cleanUrl = match.replace(/[<>"']+$/, '');
        // Decode HTML entities
        cleanUrl = cleanUrl.replace(/&amp;/g, '&');

        if (!Array.from(urls.values()).includes(cleanUrl)) {
          urls.set(`url_${urls.size}`, cleanUrl);
        }
      });

      return Array.from(urls.entries());
    });

    console.log(`  Found ${extractedUrls.length} URLs in page data`);

    // Debug: show first few URLs
    if (DEBUG && extractedUrls.length > 0) {
      console.log('  Sample URLs:');
      extractedUrls.slice(0, 3).forEach(([name, url]) => {
        console.log(`    ${name}: ${url.substring(0, 100)}...`);
      });
    }

    const capturedUrls = new Map(extractedUrls);

    // If no URLs found in page data, try a gentler click approach (single click only)
    if (capturedUrls.size === 0) {
      console.log(`  No URLs in page data. Trying single-click to reveal URLs...`);

      // Set up response listener
      page.on('response', async (response) => {
        const url = response.url();
        const isS3Url = url.includes('s3') || url.includes('amazonaws') || url.includes('cloudfront');
        const hasFileIndicator = url.includes('attachment') || url.includes('response-content') || url.includes('filename');

        if (isS3Url && hasFileIndicator) {
          const filename = extractFilename(url);
          console.log(`    ★ Captured: ${filename}`);
          capturedUrls.set(filename, url);
        }
      });

      // Try single click on first few files only (to avoid session issues)
      const filesToTry = fileInfo.slice(0, 3);
      for (const file of filesToTry) {
        try {
          console.log(`  Trying: ${file.filename}`);
          const selector = `[aria-label="${file.filename}"]`;
          const element = await page.$(selector);

          if (element) {
            await element.scrollIntoViewIfNeeded();
            await new Promise(r => setTimeout(r, 300));

            // Single click only (not double-click which causes navigation)
            await element.click();
            await new Promise(r => setTimeout(r, 1500));

            // Press Escape
            await page.keyboard.press('Escape');
            await new Promise(r => setTimeout(r, 300));
          }
        } catch (err) {
          console.log(`    Error: ${err.message}`);
          break; // Stop on error
        }
      }
    }

    // Download captured URLs via HTTP (most reliable method)
    console.log(`\nDownloading ${capturedUrls.size} files...`);

    let downloadedCount = 0;
    let previewCount = 0;
    let failedCount = 0;

    for (const [filename, url] of capturedUrls.entries()) {
      try {
        console.log(`  Downloading: ${filename}`);

        const safeName = filename.replace(/[<>:"/\\|?*]/g, '_');
        const tempPath = path.join(config.downloadDir, safeName);

        await downloadFile(url, tempPath);

        // Check actual file type
        const actualType = getFileType(tempPath);
        const expectedExt = path.extname(filename).toLowerCase().slice(1);
        const expectedType = expectedExt === 'jpg' || expectedExt === 'jpeg' ? 'jpeg' : expectedExt;

        if (actualType !== 'unknown' && actualType !== expectedType) {
          const extMap = { jpeg: '.jpg', png: '.png', pdf: '.pdf', mp3: '.mp3' };
          const correctExt = extMap[actualType] || `.${actualType}`;
          const baseName = safeName.replace(/\.[^.]+$/, '');
          const newName = `${baseName}${correctExt}`;
          const newPath = path.join(config.downloadDir, newName);

          fs.renameSync(tempPath, newPath);
          console.log(`    ⚠ Saved as ${newName} (content is ${actualType}, not ${expectedType})`);
          previewCount++;
        } else {
          const stats = fs.statSync(tempPath);
          console.log(`    ✓ ${safeName} (${Math.round(stats.size / 1024)} KB)`);
          downloadedCount++;
        }
      } catch (err) {
        console.log(`    ✗ Failed: ${err.message}`);
        failedCount++;
      }
    }

    console.log(`\n  Summary: ${downloadedCount} downloaded, ${previewCount} previews, ${failedCount} failed`);

    if (previewCount > 0) {
      console.log('\n  Note: Preview files saved with correct extension (.jpg).');
      console.log('    TaskCards serves JPEG previews instead of actual PDFs.');
      console.log('    For actual PDFs, download manually from the website.');
    }

    if (failedCount > 0) {
      console.log('\n  Note: Some downloads failed (403/timeout errors).');
      console.log('    TaskCards uses time-limited signed URLs that may expire quickly.');
      console.log('    Audio files (MP3) typically download successfully.');
      console.log('    For PDF files, download manually from the website.');
    }

    if (capturedUrls.size < fileInfo.length) {
      console.log(`\n  Warning: Only captured ${capturedUrls.size} of ${fileInfo.length} file URLs.`);
    }
  }

  return data;
}

async function scrapeGeneric(page) {
  console.log('Using generic scraping strategy...');
  await new Promise(r => setTimeout(r, 3000));

  const data = await page.evaluate((fileExtensions) => {
    const result = { title: document.title, content: [], files: [], images: [], links: [] };

    const mainContent = document.querySelector('main, article, .content, #content, .main');
    if (mainContent) result.content.push(mainContent.innerText?.substring(0, 5000));

    document.querySelectorAll('a[href]').forEach(a => {
      const href = a.href;
      if (!href || href.startsWith('javascript:')) return;
      const isFile = fileExtensions.some(ext => href.toLowerCase().includes(ext));
      if (isFile) {
        result.files.push({ url: href, name: a.innerText?.trim() || href.split('/').pop() });
      } else {
        result.links.push({ url: href, text: a.innerText?.trim() });
      }
    });

    document.querySelectorAll('img[src]').forEach(img => {
      if (img.src && !img.src.startsWith('data:')) {
        result.images.push({ url: img.src, alt: img.alt || '' });
      }
    });

    return result;
  }, FILE_EXTENSIONS);

  return data;
}

async function main() {
  const url = process.argv[2];
  const shouldDownload = process.env.DOWNLOAD === 'true';

  if (!url) {
    console.log(`
Usage: node scraper.js <URL> [options]

Examples:
  node scraper.js "https://www.taskcards.de/#/board/..."
  DEBUG=true node scraper.js "https://example.com"
  DOWNLOAD=true node scraper.js "https://example.com"

Options:
  DEBUG=true     - Show browser window
  DOWNLOAD=true  - Download files

Note: TaskCards serves JPEG preview images instead of actual PDFs.
      The scraper will detect and rename these preview files.
`);
    process.exit(1);
  }

  console.log(`\nScraping: ${url}\n`);

  if (!fs.existsSync(config.downloadDir)) {
    fs.mkdirSync(config.downloadDir, { recursive: true });
  }

  const browser = await puppeteer.launch({
    headless: config.headless ? 'new' : false,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');

    console.log('Loading page...');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: config.timeout });
    console.log('Page loaded, extracting content...\n');

    let data;
    if (url.includes('taskcards.de')) {
      data = await scrapeTaskCards(page, browser, shouldDownload);
    } else {
      data = await scrapeGeneric(page);
    }

    const screenshotPath = path.join(config.downloadDir, 'page-screenshot.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`Screenshot saved: ${screenshotPath}`);

    console.log('\n=== SCRAPE RESULTS ===\n');
    console.log(`Title: ${data.title}`);
    if (data.cards?.length > 0) console.log(`\nCards found: ${data.cards.length}`);
    console.log(`\nImages found: ${data.images?.length || 0}`);
    console.log(`Links found: ${data.links?.length || 0}`);
    console.log(`\nDownloadable files: ${data.files?.length || 0}`);

    if (data.files?.length > 0) {
      console.log('\nFiles:');
      data.files.forEach((file, i) => console.log(`  ${i + 1}. ${file.name}`));
    }

    const resultsPath = path.join(config.downloadDir, 'scrape-results.json');
    fs.writeFileSync(resultsPath, JSON.stringify(data, null, 2));
    console.log(`\nFull results saved: ${resultsPath}`);

    if (!shouldDownload && data.files?.length > 0) {
      console.log('\nTo download files, run with: DOWNLOAD=true node scraper.js <url>');
    }

  } finally {
    await browser.close();
  }

  console.log('\nDone!');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
