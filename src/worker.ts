// eslint-disable-next-line no-console
console.log('Worker starting...');

// Worker implementation will be added in M4
process.on('SIGTERM', () => {
  // eslint-disable-next-line no-console
  console.log('Worker shutting down...');
  process.exit(0);
});
