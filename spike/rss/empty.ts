/** Empty Bun process: print RSS and exit. Baseline for D14. */
console.log(`rss_mb=${(process.memoryUsage().rss / 1048576).toFixed(1)}`);
