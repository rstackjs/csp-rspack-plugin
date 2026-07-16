require.ensure([], () => {
  document.body.dataset.message = require('./real-content-hash-async'); // eslint-disable-line global-require
});
