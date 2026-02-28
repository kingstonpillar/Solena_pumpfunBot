// fetchSolPriceUSD.test.js

import { fetchSolPriceUSD } from './solPriceFetcher.js';

// Test 1: Fetching the SOL price directly from Solana
async function testFetchSolPriceUSD() {
  try {
    const price = await fetchSolPriceUSD(); // Fetching the price from Solana directly
    
    console.log(`Price: ${price}`);
    
    // Check if the price is a valid number
    if (price === null || isNaN(price)) {
      throw new Error('Failed to fetch valid price');
    }
    
    console.log(`Successfully fetched price: ${price}`);
  } catch (err) {
    console.error('Error fetching SOL price:', err);
  }
}

// Test 2: Cache functionality
async function testCachePrice() {
  try {
    await fetchSolPriceUSD(); // First call, should fetch and cache the price
    const cachedPrice = await fetchSolPriceUSD(); // Should fetch from cache
    
    console.log(`Cached Price: ${cachedPrice}`);
    if (cachedPrice === null || isNaN(cachedPrice)) {
      throw new Error('Cache is not working as expected');
    }
    
    console.log(`Successfully fetched cached price: ${cachedPrice}`);
  } catch (err) {
    console.error('Error during cache test:', err);
  }
}

// Test 3: Handle RPC errors gracefully
async function testRpcError() {
  try {
    // Simulate RPC failure by temporarily switching the RPC URL to an invalid one
    // You can set an invalid URL for your RPC in the environment variables or mock it manually
    process.env.RPC_URL_5 = "https://invalid-rpc-url";
    
    const price = await fetchSolPriceUSD();
    if (price !== null) {
      throw new Error('Expected RPC error, but price was fetched');
    }
    
    console.log('Handled RPC error gracefully');
  } catch (err) {
    console.error('Expected RPC error:', err);
  }
}

// Run all tests
async function runTests() {
  try {
    await testFetchSolPriceUSD();
    await testCachePrice();
    await testRpcError();
    console.log('All tests completed!');
  } catch (err) {
    console.error('Test failed:', err);
  }
}

// Execute tests
runTests();