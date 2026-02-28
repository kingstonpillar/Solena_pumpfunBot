// test.js

import { fetchSolPriceUSD } from './solPriceFetcher.js';  // Import the function

async function testFetchSolPrice() {
  const price = await fetchSolPriceUSD();  // Fetch SOL price using Jupiter API
  console.log(`Current SOL Price in USD: ${price}`);
}

testFetchSolPrice();  // Run the test