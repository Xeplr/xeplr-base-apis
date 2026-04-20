var cluster = require('cluster');
var os = require('os');

/**
 * Run an Express app across multiple worker processes using Node.js cluster.
 *
 * The primary process forks workers and manages lifecycle.
 * Each worker runs the app independently with its own event loop.
 *
 * Workers can notify each other via `broadcast()` — primary relays
 * the message to all other workers.
 *
 * Usage:
 *
 *   var { runCluster } = require('@xeplr/base-apis');
 *
 *   runCluster({
 *     workers: 4,                        // default: CPU count
 *     start: function() {                // called in each worker
 *       var { createApp } = require('@xeplr/base-apis');
 *       createApp(3000, 'myapp', { routes: { ... } });
 *     },
 *     onMessage: function(msg) {         // called in each worker when broadcast received
 *       if (msg.type === 'cache-clear') clearLocalCache();
 *     }
 *   });
 *
 * Inside a worker, notify others:
 *
 *   var { broadcast } = require('@xeplr/base-apis/lib/cluster');
 *   broadcast({ type: 'cache-clear', key: 'users' });
 *
 * @param {object}   options
 * @param {Function} options.start      - Called in each worker to boot the app
 * @param {number}   [options.workers]  - Number of workers (default: os.cpus().length)
 * @param {Function} [options.onMessage] - Handler for broadcast messages in workers
 * @param {boolean}  [options.respawn]  - Restart crashed workers (default: true)
 */
function runCluster(options) {
  var workerCount = options.workers || os.cpus().length;
  var respawn = options.respawn !== false;

  if (cluster.isPrimary) {
    console.log('[cluster] Primary ' + process.pid + ' starting ' + workerCount + ' workers');

    // Fork workers
    for (var i = 0; i < workerCount; i++) {
      cluster.fork();
    }

    // Relay messages from one worker to all others
    cluster.on('message', function(sender, msg) {
      if (msg && msg._broadcast) {
        for (var id in cluster.workers) {
          var worker = cluster.workers[id];
          if (worker && worker !== sender && !worker.isDead()) {
            worker.send(msg);
          }
        }
      }
    });

    // Respawn dead workers
    cluster.on('exit', function(worker, code, signal) {
      console.log('[cluster] Worker ' + worker.process.pid + ' died (' + (signal || code) + ')');
      if (respawn) {
        console.log('[cluster] Spawning replacement worker');
        cluster.fork();
      }
    });
  } else {
    // Worker process — boot the app
    options.start();

    // Listen for broadcast messages from other workers
    if (options.onMessage) {
      process.on('message', function(msg) {
        if (msg && msg._broadcast) {
          options.onMessage(msg);
        }
      });
    }

    console.log('[cluster] Worker ' + process.pid + ' started');
  }
}

/**
 * Send a message to all other workers via the primary process.
 * Call this from within a worker process.
 *
 * @param {object} msg - Any serializable object. Gets `_broadcast: true` added.
 */
function broadcast(msg) {
  if (!process.send) return; // not in a cluster worker
  msg._broadcast = true;
  process.send(msg);
}

/**
 * Check if current process is the primary.
 */
function isPrimary() {
  return cluster.isPrimary;
}

/**
 * Check if current process is a worker.
 */
function isWorker() {
  return cluster.isWorker;
}

module.exports = { runCluster, broadcast, isPrimary, isWorker };
