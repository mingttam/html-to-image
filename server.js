const express = require("express");
const puppeteer = require("puppeteer");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 1234;

// Performance optimizations
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT) || 5;
const CACHE_TTL = parseInt(process.env.CACHE_TTL) || 300000; // 5 minutes

// Simple in-memory cache for repeated requests
const imageCache = new Map();
let activeRequests = 0;

// Queue system for handling concurrent requests
const requestQueue = [];
let processing = false;

// Browser instance management
let browser = null;

// Middleware optimizations
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Add security headers
app.use((req, res, next) => {
  res.set({
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-XSS-Protection": "1; mode=block",
  });
  next();
});

// Request throttling middleware
app.use((req, res, next) => {
  if (activeRequests >= MAX_CONCURRENT && req.path === "/html-to-image") {
    return res.status(429).json({
      error: "Server busy",
      message: "Too many concurrent requests. Please retry in a few seconds.",
      retryAfter: 3,
    });
  }
  next();
});

// Image generation options
const imageOptions = {
  width: 1920,
  height: 1080,
  deviceScaleFactor: 1,
  fullPage: true,
  type: "png", // png, jpeg, webp
  quality: 90, // for jpeg
  timeout: 25000,
};

// Initialize browser instance
async function initBrowser() {
  if (!browser) {
    const launchOptions = {
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-first-run",
        "--no-zygote",
        "--single-process",
        "--disable-extensions",
        "--disable-default-apps",
        "--disable-web-security",
        "--disable-features=VizDisplayCompositor",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
        "--disable-ipc-flooding-protection",
        "--enable-features=NetworkService,NetworkServiceInProcess",
        "--force-color-profile=srgb",
        "--metrics-recording-only",
        "--use-mock-keychain",
      ],
    };

    // Sử dụng executablePath nếu trong Docker container
    // if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    //   launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    // }

    if (process.env.PUPPETEER_EXECUTABLE_PATH && 
        process.env.PUPPETEER_EXECUTABLE_PATH !== '/usr/bin/chromium-browser') {
      launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
      console.log('🔧 Using custom Chrome path:', process.env.PUPPETEER_EXECUTABLE_PATH);
    } else {
      console.log('🔍 Using Puppeteer bundled Chrome from cache');
    }

    try {
      browser = await puppeteer.launch(launchOptions);
      console.log("🌐 Browser initialized successfully");
    } catch (error) {
      console.error("❌ Failed to initialize browser:", error.message);

      // Retry với cấu hình đơn giản hơn
      console.log("🔄 Retrying with minimal configuration...");
      launchOptions.args = [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--single-process",
      ];

      delete launchOptions.executablePath;

      browser = await puppeteer.launch(launchOptions);
      console.log("🌐 Browser initialized with minimal config");
    }
  }
  return browser;
}

// Utility functions
function generateCacheKey(html, options) {
  const content = html + JSON.stringify(options);
  return crypto.createHash("md5").update(content).digest("hex");
}

function cleanupCache() {
  const now = Date.now();
  for (const [key, data] of imageCache.entries()) {
    if (now - data.timestamp > CACHE_TTL) {
      imageCache.delete(key);
    }
  }
}

// Cleanup cache every 5 minutes
setInterval(cleanupCache, 300000);

// Optimized image generation with caching
async function generateImageOptimized(html, options = {}) {
  const startTime = Date.now();
  const cacheKey = generateCacheKey(html, options);

  // Check cache first
  if (imageCache.has(cacheKey)) {
    const cached = imageCache.get(cacheKey);
    if (Date.now() - cached.timestamp < CACHE_TTL) {
      console.log(`Image served from cache (${Date.now() - startTime}ms)`);
      return cached.buffer;
    } else {
      imageCache.delete(cacheKey);
    }
  }

  const finalOptions = { ...imageOptions, ...options };

  // Initialize browser if needed
  const browserInstance = await initBrowser();
  const page = await browserInstance.newPage();

  try {
    // Set viewport
    await page.setViewport({
      width: finalOptions.width,
      height: finalOptions.height,
      deviceScaleFactor: finalOptions.deviceScaleFactor,
    });

    // Set content and wait for load
    await page.setContent(html, {
      waitUntil: "networkidle0",
      timeout: finalOptions.timeout,
    });

    // Generate screenshot
    const screenshotOptions = {
      fullPage: finalOptions.fullPage,
      type: finalOptions.type,
    };

    if (finalOptions.type === "jpeg") {
      screenshotOptions.quality = finalOptions.quality;
    }

    const imageBuffer = await page.screenshot(screenshotOptions);

    // Cache the result
    imageCache.set(cacheKey, {
      buffer: imageBuffer,
      timestamp: Date.now(),
    });

    const processingTime = Date.now() - startTime;
    console.log(
      `Image generated and cached (${processingTime}ms, ${imageBuffer.length} bytes)`
    );

    return imageBuffer;
  } finally {
    await page.close();
  }
}

app.get("/", (req, res) => {
  const memUsage = process.memoryUsage();
  res.json({
    message: "High-Performance HTML to Image Server",
    version: "2.1.0",
    engine: "puppeteer",
    status: {
      activeRequests: activeRequests,
      maxConcurrent: MAX_CONCURRENT,
      cacheSize: imageCache.size,
      uptime: Math.round(process.uptime()),
      memory: {
        used: Math.round(memUsage.heapUsed / 1024 / 1024) + "MB",
        total: Math.round(memUsage.heapTotal / 1024 / 1024) + "MB",
      },
    },
    endpoints: {
      "html-to-image": "POST /html-to-image - Convert HTML to Image (cached)",
      test: "GET /test-image - Generate test image",
      health: "GET / - Health check and status",
      "cache-clear": "POST /cache-clear - Clear image cache",
    },
  });
});

// Cache management endpoint
app.post("/cache-clear", (req, res) => {
  const cacheSize = imageCache.size;
  imageCache.clear();
  res.json({
    message: "Cache cleared successfully",
    clearedEntries: cacheSize,
    timestamp: new Date().toISOString(),
  });
});

app.post("/html-to-image", async (req, res) => {
  const requestStart = Date.now();
  activeRequests++;

  try {
    const { html, options = {} } = req.body;

    // Enhanced validation
    if (!html) {
      return res.status(400).json({
        error: "HTML content is required",
        usage: "Send JSON with 'html' field containing HTML content",
      });
    }

    if (html.length > 10 * 1024 * 1024) {
      // 10MB limit
      return res.status(413).json({
        error: "HTML content too large",
        maxSize: "10MB",
        received: `${Math.round((html.length / 1024 / 1024) * 100) / 100}MB`,
      });
    }

    console.log(
      `[${new Date().toISOString()}] Processing image request (${
        html.length
      } chars, ${activeRequests} active)`
    );

    // Use optimized image generation with caching
    const imageBuffer = await generateImageOptimized(html, options);
    const totalTime = Date.now() - requestStart;

    // Determine content type based on image format
    const format = options.type || imageOptions.type;
    const contentType =
      format === "jpeg"
        ? "image/jpeg"
        : format === "webp"
        ? "image/webp"
        : "image/png";

    // Set optimized headers
    res.setHeader("Content-Type", contentType);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="screenshot.${format}"`
    );
    res.setHeader("Content-Length", imageBuffer.length);
    res.setHeader("X-Processing-Time", `${totalTime}ms`);
    res.setHeader(
      "X-Cache-Status",
      imageCache.has(generateCacheKey(html, options)) ? "HIT" : "MISS"
    );

    res.send(imageBuffer);

    console.log(
      `[${new Date().toISOString()}] Image delivered (${totalTime}ms, ${
        imageBuffer.length
      } bytes)`
    );
  } catch (error) {
    const totalTime = Date.now() - requestStart;
    console.error(
      `[${new Date().toISOString()}] Image generation failed (${totalTime}ms):`,
      error.message
    );

    res.status(500).json({
      error: "Failed to generate image",
      details: error.message,
      processingTime: `${totalTime}ms`,
      timestamp: new Date().toISOString(),
    });
  } finally {
    activeRequests = Math.max(0, activeRequests - 1);
  }
});

app.get("/test-image", async (req, res) => {
  const startTime = Date.now();
  activeRequests++;

  const testHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        body { 
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; 
          margin: 20px; 
          line-height: 1.6;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
          min-height: 100vh;
          display: flex;
          flex-direction: column;
          justify-content: center;
        }
        .container {
          max-width: 800px;
          margin: 0 auto;
          text-align: center;
        }
        h1 { 
          color: #ffffff; 
          margin-bottom: 20px; 
          font-size: 3em;
          text-shadow: 2px 2px 4px rgba(0,0,0,0.3);
        }
        .info { 
          background: rgba(255,255,255,0.1); 
          padding: 30px; 
          border-radius: 15px; 
          margin: 20px 0; 
          backdrop-filter: blur(10px);
          border: 1px solid rgba(255,255,255,0.2);
        }
        .performance { 
          color: #00ff88; 
          font-weight: bold; 
          font-size: 1.2em;
        }
        .timestamp {
          font-size: 0.9em;
          opacity: 0.8;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>📸 High-Performance Image Generator</h1>
        <div class="info">
          <p><strong>Generated at:</strong> <span class="timestamp">${new Date().toISOString()}</span></p>
          <p><strong>Engine:</strong> Puppeteer (optimized)</p>
          <p><strong>Features:</strong> Caching, Queue Management, Multiple Formats</p>
          <p class="performance">⚡ Optimized for speed and quality!</p>
        </div>
        <p>This image demonstrates the enhanced performance capabilities of the server.</p>
        <p>Subsequent requests for identical content will be served from cache for instant delivery.</p>
        <p>🚀 Supports PNG, JPEG, and WebP formats</p>
      </div>
    </body>
    </html>
  `;

  try {
    console.log(`[${new Date().toISOString()}] Generating test image...`);

    const imageBuffer = await generateImageOptimized(testHtml, {});
    const processingTime = Date.now() - startTime;

    res.setHeader("Content-Type", "image/png");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="performance-test.png"'
    );
    res.setHeader("Content-Length", imageBuffer.length);
    res.setHeader("X-Processing-Time", `${processingTime}ms`);

    res.send(imageBuffer);

    console.log(
      `[${new Date().toISOString()}] Test image delivered (${processingTime}ms)`
    );
  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error(`Test image failed (${processingTime}ms):`, error.message);
    res.status(500).json({
      error: "Test failed",
      details: error.message,
      processingTime: `${processingTime}ms`,
    });
  } finally {
    activeRequests = Math.max(0, activeRequests - 1);
  }
});

// Enhanced server startup with performance monitoring
const server = app.listen(PORT, async () => {
  console.log(`🚀 High-Performance Image Server started`);
  console.log(`📡 Port: ${PORT}`);
  console.log(`⚡ Max concurrent requests: ${MAX_CONCURRENT}`);
  console.log(`💾 Cache TTL: ${CACHE_TTL / 1000}s`);
  console.log(`🏃 Node.js: ${process.version}`);
  console.log(`💻 Platform: ${process.platform} ${process.arch}`);
  console.log(
    `🌐 Environment: ${IS_PRODUCTION ? "Production" : "Development"}`
  );
  console.log(`📸 Default format: ${imageOptions.type.toUpperCase()}`);
  console.log(`📏 Default size: ${imageOptions.width}x${imageOptions.height}`);
  console.log(`\n📊 Endpoints:`);
  console.log(`   GET  / - Health check and metrics`);
  console.log(`   POST /html-to-image - Convert HTML to Image (cached)`);
  console.log(`   GET  /test-image - Performance test`);
  console.log(`   POST /cache-clear - Clear cache\n`);

  // Initialize browser on startup
  try {
    await initBrowser();
  } catch (error) {
    console.error(`❌ Failed to initialize browser on startup:`, error.message);
    console.log(`⚠️  Browser will be initialized on first request`);
  }
});

// Optimize server settings
server.timeout = 30000; // 30 seconds
server.keepAliveTimeout = 5000; // 5 seconds
server.headersTimeout = 6000; // 6 seconds

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("📋 SIGTERM received, shutting down gracefully...");
  server.close(async () => {
    console.log("✅ HTTP server closed");
    imageCache.clear();
    console.log("🗑️  Cache cleared");
    if (browser) {
      await browser.close();
      console.log("🌐 Browser closed");
    }
    process.exit(0);
  });
});

process.on("SIGINT", async () => {
  console.log("\n📋 SIGINT received, shutting down gracefully...");
  server.close(async () => {
    console.log("✅ HTTP server closed");
    imageCache.clear();
    console.log("🗑️  Cache cleared");
    if (browser) {
      await browser.close();
      console.log("🌐 Browser closed");
    }
    process.exit(0);
  });
});

// Performance monitoring
if (IS_PRODUCTION) {
  setInterval(() => {
    const memUsage = process.memoryUsage();
    console.log(
      `📊 Stats - Active: ${activeRequests}, Cache: ${
        imageCache.size
      }, Memory: ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`
    );
  }, 60000); // Log every minute
}
