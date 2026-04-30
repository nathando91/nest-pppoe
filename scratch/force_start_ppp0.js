
const { setupProxy, getSessionIP, isPrivateIP, killPppd, killProxy } = require('../lib/pppoe');
const nestproxy = require('../lib/nestproxy');

async function forceStart(id) {
    console.log(`\n🚀 Force starting ppp${id}...`);
    
    // 1. Check IP
    const iface = 'ppp' + id;
    const ip = await getSessionIP(iface);
    if (!ip || isPrivateIP(ip)) {
        console.log(`❌ ppp${id} has no valid Public IP. Please rotate it first.`);
        return;
    }
    console.log(`✅ ppp${id} has IP: ${ip}`);

    // 2. Cleanup old proxy
    await killProxy(id);
    
    // 3. Setup Proxy (This will recreate the _active.cfg file)
    console.log(`📝 Recreating config and starting 3proxy...`);
    const result = await setupProxy(id, ip);
    console.log(`✅ 3proxy started on port ${result.vipPort}`);

    // 4. Sync with NestProxy
    try {
        await nestproxy.pushSessionProxies(id, ip, result.ports);
        console.log(`✅ Synced with NestProxy server`);
    } catch (e) {
        console.log(`⚠️ Sync failed: ${e.message}`);
    }
}

forceStart(0).then(() => {
    console.log("Done.");
    process.exit(0);
});
