const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const chromePath = path.join(process.env.HOME || '/workspace', '.cache/puppeteer');

console.log('🔍 Checking Chrome installation...');
console.log('📁 Cache path:', chromePath);

try {
  if (!fs.existsSync(chromePath) || fs.readdirSync(chromePath).length === 0) {
    console.log('📦 Chrome not found. Installing...');
    execSync('npx puppeteer browsers install chrome', { 
      stdio: 'inherit',
      env: { ...process.env, PUPPETEER_SKIP_CHROMIUM_DOWNLOAD: 'false' }
    });
    console.log('✅ Chrome installed successfully');
  } else {
    console.log('✅ Chrome already installed');
    // Kiểm tra version
    const dirs = fs.readdirSync(chromePath);
    console.log('📦 Found Chrome versions:', dirs);
  }
} catch (error) {
  console.error('❌ Error installing Chrome:', error.message);
  process.exit(1);
}