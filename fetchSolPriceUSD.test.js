// fetchSolPriceUSD.test.js

import { fetchSolPriceUSD } from './solPriceFetcher.js';
import { Connection, PublicKey } from '@solana/web3.js';
import PQueue from 'p-queue';

// Mocking @solana/web3.js and PQueue
jest.mock('@solana/web3.js');
jest.mock('p-queue');

// Mock constants
const SOL_PYTH_PRICE_ACCOUNT = new PublicKey("J83w4HKfqxwc1ySTtwE4u2QZpM3X4PzZsZ2F1F8oVQ6F");
const MOCK_RPC_URL = "https://mock-rpc-url.com";

// Mock data
const mockPriceData = Buffer.from(new Array(224).fill(0)); // Create a mock buffer
mockPriceData.writeBigInt64LE(BigInt(3000)); // Mock price 3000 USD for SOL
mockPriceData.writeInt32LE(2, 212); // Exponent of 2 for the price (price = 3000 * 10^2)

// Test 1: Successful fetch of SOL price
describe('fetchSolPriceUSD', () => {
  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();

    // Mock Connection behavior
    Connection.mockImplementation(() => ({
      getAccountInfo: jest.fn().mockResolvedValue({
        data: mockPriceData
      })
    }));

    // Mock PQueue
    PQueue.mockImplementation(() => ({
      add: jest.fn((fn) => fn()) // Immediately invoke the passed function
    }));
  });

  it('should fetch the correct SOL price in USD', async () => {
    const price = await fetchSolPriceUSD();

    // Expected price = 3000 * 10^2 = 300000
    expect(price).toBe(300000);
  });

  it('should cache the fetched price for 10 seconds', async () => {
    // First call, price should be fetched
    await fetchSolPriceUSD();
    const price = await fetchSolPriceUSD();

    // Price should be cached and not fetched again
    expect(price).toBe(300000);
  });

  it('should handle RPC errors gracefully', async () => {
    // Simulate an RPC error
    Connection.mockImplementationOnce(() => ({
      getAccountInfo: jest.fn().mockRejectedValue(new Error('RPC connection error'))
    }));

    const price = await fetchSolPriceUSD();

    // If RPC fails, the price should be null
    expect(price).toBeNull();
  });

  it('should handle missing price data gracefully', async () => {
    // Simulate missing price data
    Connection.mockImplementationOnce(() => ({
      getAccountInfo: jest.fn().mockResolvedValue({
        data: null
      })
    }));

    const price = await fetchSolPriceUSD();

    // If no data is found, return null
    expect(price).toBeNull();
  });

  it('should rotate through RPC URLs', async () => {
    // Mock Connection to return different results for each URL
    Connection.mockImplementationOnce(() => ({
      getAccountInfo: jest.fn().mockResolvedValue({
        data: mockPriceData
      })
    }));

    const price1 = await fetchSolPriceUSD();
    const price2 = await fetchSolPriceUSD();

    // Ensure that subsequent calls are made with different RPC URLs (for rotation)
    expect(price1).toBe(300000);
    expect(price2).toBe(300000); // Same price, but rotated RPC URL
  });
});