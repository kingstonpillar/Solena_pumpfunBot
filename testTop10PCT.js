import { Top10PCT } from './heliusTop10.js'; // Make sure to adjust the path to where your Top10PCT function is defined.

const mintAddress = "HqbqHzaf1NuPno2ya2z28zV9Kksjpe5grAreEfhpump";  // Replace with the actual mint address you want to test

(async () => {
  try {
    console.log(`Fetching top 10 holders for mint address: ${mintAddress}`);

    const top10Percentage = await Top10PCT(mintAddress); // Call Top10PCT with the mint address

    if (top10Percentage !== null) {
      console.log(`Top 10 holders own: ${top10Percentage}% of the total supply.`);
    } else {
      console.log("Could not calculate the top 10 percentage.");
    }
  } catch (error) {
    console.error("Error during the test execution:", error);
  }
})();