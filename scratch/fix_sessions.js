
const { connectPppoe, setupProxy, killPppd, killProxy, getSessionIP, isPrivateIP } = require('../lib/pppoe');
const healthCheck = require('../lib/healthcheck');
const nestproxy = require('../lib/nestproxy');
const { readConfig } = require('../lib/config');

async function fixSession(id) {
    console.log(`\n--- Fixing ppp${id} ---`);
    
    // 1. Force cleanup
    await killProxy(id);
    await killPppd(id);
    
    // 2. Mark as started for healthcheck
    healthCheck.markStarted(id);
    
    // 3. Connect
    const ip = await connectPppoe(id);
    if (!ip) {
        console.log(`❌ ppp${id} failed to get IP`);
        return;
    }
    
    if (isPrivateIP(ip)) {
        console.log(`⚠️ ppp${id} got CGNAT IP: ${ip}. Killing.`);
        await killPppd(id);
        return;
    }
    
    console.log(`✅ ppp${id} got IP: ${ip}`);
    
    // 4. Setup Proxy
    const result = await setupProxy(id, ip);
    console.log(`✅ ppp${id} proxy setup on port ${result.vipPort}`);
    
    // 5. Sync with NestProxy (optional but good)
    try {
        await nestproxy.pushSessionProxies(id, ip, result.ports);
        console.log(`✅ ppp${id} synced with NestProxy server`);
    } catch (e) {
        console.log(`⚠️ NestProxy sync failed: ${e.message}`);
    }
}

async function run() {
    // We need to mock 'io' for some modules if they use it
    // But pushSessionProxies might fail without it. 
    // Let's just fix the local state.
    
    await fixSession(0);
    await fixSession(3);
    console.log('\nDone. Please refresh the dashboard.');
    process.exit(0);
}

run();
