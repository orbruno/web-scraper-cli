import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';

const OUTPUT_DIR = process.env.OUTPUT_DIR || './screenshots';

// Layouts to capture - organized by category
const LAYOUTS = {
  heroes: [
    'hero-alpha', 'hero-bravo', 'hero-charlie', 'hero-delta',
    'hero-barcelona', 'hero-atlanta', 'hero-cali'
  ],
  features: [
    'feature-section-alpha', 'feature-section-milan', 'feature-section-iceland',
    'feature-section-chicago', 'feature-section-dallas'
  ],
  headers: [
    'header-alpha', 'header-basel', 'header-london'
  ],
  footers: [
    'footer-alpha', 'footer-amsterdam', 'footer-november'
  ],
  pricing: [
    'pricing-section-alpha', 'pricing-section-echo', 'pricing-section-mike'
  ],
  testimonials: [
    'testimonial-section-alpha', 'testimonial-section-oscar'
  ],
  ctas: [
    'cta-section-alpha', 'cta-section-victor'
  ],
  content: [
    'content-section-alpha', 'content-section-yankee', 'content-section-zulu'
  ]
};

async function captureLayout(browser, layoutSlug, category) {
  const url = `https://getframes.io/layouts/${layoutSlug}/`;
  const page = await browser.newPage();

  try {
    console.log(`Capturing: ${layoutSlug}`);

    // Set viewport for desktop
    await page.setViewport({ width: 1920, height: 1080 });

    // Navigate and wait for network idle
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    // Wait for the preview iframe to load
    await page.waitForSelector('iframe', { timeout: 10000 });

    // Wait a bit more for content to render
    await new Promise(r => setTimeout(r, 2000));

    // Try to get the iframe and screenshot its content
    const iframeElement = await page.$('iframe');

    if (iframeElement) {
      // Get iframe bounding box
      const box = await iframeElement.boundingBox();

      if (box) {
        // Create category directory
        const categoryDir = path.join(OUTPUT_DIR, category);
        if (!fs.existsSync(categoryDir)) {
          fs.mkdirSync(categoryDir, { recursive: true });
        }

        // Screenshot the iframe area
        await page.screenshot({
          path: path.join(categoryDir, `${layoutSlug}.png`),
          clip: {
            x: box.x,
            y: box.y,
            width: Math.min(box.width, 1920),
            height: Math.min(box.height, 1080)
          }
        });

        console.log(`  ✓ Saved: ${category}/${layoutSlug}.png`);
      }
    } else {
      // Fallback: screenshot the full page
      const categoryDir = path.join(OUTPUT_DIR, category);
      if (!fs.existsSync(categoryDir)) {
        fs.mkdirSync(categoryDir, { recursive: true });
      }

      await page.screenshot({
        path: path.join(categoryDir, `${layoutSlug}.png`),
        fullPage: false
      });
      console.log(`  ✓ Saved (full page): ${category}/${layoutSlug}.png`);
    }

  } catch (error) {
    console.error(`  ✗ Error capturing ${layoutSlug}:`, error.message);
  } finally {
    await page.close();
  }
}

async function main() {
  // Create output directory
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  console.log('Starting Frames Layout Screenshot Capture...\n');
  console.log(`Output directory: ${OUTPUT_DIR}\n`);

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    for (const [category, layouts] of Object.entries(LAYOUTS)) {
      console.log(`\n=== ${category.toUpperCase()} ===`);

      for (const layoutSlug of layouts) {
        await captureLayout(browser, layoutSlug, category);
        // Small delay between captures
        await new Promise(r => setTimeout(r, 500));
      }
    }

    console.log('\n✓ Screenshot capture complete!');
    console.log(`Screenshots saved to: ${OUTPUT_DIR}`);

  } finally {
    await browser.close();
  }
}

main().catch(console.error);
