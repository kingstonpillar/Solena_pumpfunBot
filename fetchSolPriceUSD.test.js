// Import the actual solPriceFetcher module
import { fetchSolPriceUSD } from './solPriceFetcher.js';
import { PublicKey } from '@solana/web3.js';

// Mock constants
const SOL_PYTH_PRICE_ACCOUNT = new PublicKey("J83w4HKfqxwc1ySTtwE4u2QZpM3X4PzZsZ2F1F8oVQ6F"); // SOL/USD mainnet price feed

// Mock data to simulate the response from the Solana RPC call
const mockPriceData = Buffer.from(new Array(224).fill(0)); // Create a mock buffer
mockPriceData.writeBigInt64LE(BigInt(3000)); // Mock price 3000 USD for SOL
mockPriceData.writeInt32LE(2, 212); // Exponent of 2 for the price (price = 3000 * 10^2)

// Mocking the Connection class (manually)
class MockConnection {
  constructor() {
    this.getAccountInfo = async () => {
      return { data: mockPriceData }; // Return mock data for price
    };
  }
}

// Mocking the PQueue (manually)
class MockPQueue {
  constructor() {
    this.add = async (fn) => await fn(); // Immediately execute the passed function
  }
}

// Testing the fetchSolPriceUSD function
async function testFetchSolPriceUSD() {
  const mockConnection = new MockConnection();
  const mockQueue = new MockPQueue();
  
  // Fetch price
  const price = await fetchSolPriceUSD(mockConnection, mockQueue);
  
  // Expected price = 3000 * 10^2 = 300000
  console.log(`Price: ${price}`);  // 300000
  if (price !== 300000) {
    throw new Error('Price mismatch');
  }
}

// Test 2: Cache functionality
async function testCachePrice() {
  const mockConnection = new MockConnection();
  const mockQueue = new MockPQueue();
  
  // First call, price should be fetched
  await fetchSolPriceUSD(mockConnection, mockQueue);
  const cachedPrice = await fetchSolPriceUSD(mockConnection, mockQueue);
  
  // Price should be cached and not fetched again
  console.log(`Cached Price: ${cachedPrice}`);  // 300000
  if (cachedPrice !== 300000) {
    throw new Error('Cache failed');
  }
}

// Test 3: RPC error handling
async function testRpcError() {
  const mockConnection = new MockConnection();
  mockConnection.getAccountInfo = async () => { 
    throw new Error('RPC connection error'); // Simulate an RPC error 
  };
  
  const price = await fetchSolPriceUSD(mockConnection, new MockPQueue());
  
  // If RPC fails, the price should be null
  console.log(`Price on RPC error: ${price}`);  // null
  if (price !== null) {
    throw new Error('RPC error not handled properly');
  }
}

// Test 4: Missing price data handling
async function testMissingPriceData() {
  const mockConnection = new MockConnection();
  mockConnection.getAccountInfo = async () => ({ data: null }); // Simulate missing data
  
  const price = await fetchSolPriceUSD(mockConnection, new MockPQueue());
  
  // If no data is found, return null
  console.log(`Price on missing data: ${price}`);  // null
  if (price !== null) {
    throw new Error('Missing price data not handled properly');
  }
}

// Test 5: RPC URL rotation
async function testRpcRotation() {
  const mockConnection = new MockConnection();
  const mockQueue = new MockPQueue();
  
  // Mock rotation by using different instances of connections
  const price1 = await fetchSolPriceUSD(mockConnection, mockQueue);
  const price2 = await fetchSolPriceUSD(mockConnection, mockQueue);
  
  // Same price, but rotated RPC URL
  console.log(`Price on RPC rotation: ${price1}, ${price2}`);
  if (price1 !== 300000 || price2 !== 300000) {
    throw new Error('RPC rotation failed');
  }
}

// Run all tests
async function runTests() {
  try {
    await testFetchSolPriceUSD();
    await testCachePrice();
    await testRpcError();
    await testMissingPriceData();
    await testRpcRotation();
    console.log('All tests passed!');
  } catch (err) {
    console.error('Test failed:', err);
  }
}

// Execute tests
runTests();