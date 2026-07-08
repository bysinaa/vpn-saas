const { PrismaClient } = require('@prisma/client');
const fetch = require('node-fetch');

const prisma = new PrismaClient();

async function main() {
  // 1. Get panel from DB
  const panels = await prisma.vpnPanel.findMany({});
  
  console.log('=== PANELS ===');
  for (const panel of panels) {
    console.log(`ID: ${panel.id}, Name: ${panel.name}, Type: ${panel.type}`);
    console.log(`BaseURL: ${panel.baseUrl}`);
    console.log(`Status: ${panel.status}`);
    console.log(`Metadata:`, JSON.stringify(panel.metadata, null, 2));
    console.log('---');
  }

  if (panels.length === 0) {
    console.log('No panels found in database!');
    await prisma.$disconnect();
    return;
  }

  const panel = panels[0];
  const baseUrl = panel.baseUrl.replace(/\/$/, '');
  
  // Get credentials from environment variables (SANITY_PANEL_USERNAME / SANITY_PANEL_PASSWORD)
  const username = process.env.SANITY_PANEL_USERNAME;
  const password = process.env.SANITY_PANEL_PASSWORD;
  
  if (!username || !password) {
    console.log('No credentials found! Set SANITY_PANEL_USERNAME and SANITY_PANEL_PASSWORD env vars.');
    await prisma.$disconnect();
    return;
  }

  // 2. Test login to 3x-ui
  console.log('\n=== TESTING LOGIN ===');
  
  // Step 1: Get CSRF token
  const csrfUrl = `${baseUrl}/csrf-token`;
  console.log('Getting CSRF token from:', csrfUrl);
  
  let csrfRes;
  try {
    csrfRes = await fetch(csrfUrl, { 
      method: 'GET', 
      headers: { Accept: 'application/json' } 
    });
    const csrfBody = await csrfRes.json();
    console.log('CSRF Response:', csrfBody);
    
    if (!csrfBody.success || !csrfBody.obj) {
      console.log('Failed to get CSRF token');
      await prisma.$disconnect();
      return;
    }
    
    const csrfToken = csrfBody.obj;
    let cookie = '';
    const setCookie = csrfRes.headers.get('set-cookie');
    if (setCookie) {
      cookie = setCookie.split(';')[0];
    }

    // Step 2: Login
    console.log('\nLogging in...');
    const loginUrl = `${baseUrl}/login`;
    const form = new URLSearchParams({ username, password });
    
    const loginRes = await fetch(loginUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-CSRF-Token': csrfToken,
        Cookie: cookie,
        Accept: 'application/json',
      },
      body: form.toString(),
    });
    
    const loginBody = await loginRes.json();
    console.log('Login Response:', loginBody);
    
    if (!loginBody.success) {
      console.log('Login failed!');
      await prisma.$disconnect();
      return;
    }
    
    // Get cookie from login response
    const loginCookie = loginRes.headers.get('set-cookie');
    if (loginCookie) {
      cookie = loginCookie.split(';')[0];
      console.log('Got session cookie');
    }

    // Step 3: Test creating a client with the EXACT API format
    console.log('\n=== TESTING CLIENT CREATION ===');
    
    // First, get inbounds
    console.log('Getting inbounds...');
    const inboundsRes = await fetch(`${baseUrl}/panel/api/inbounds/list`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-CSRF-Token': csrfToken,
        Cookie: cookie,
      },
    });
    const inboundsBody = await inboundsRes.json();
    console.log('Inbounds response:', inboundsBody);
    
    const inbounds = inboundsBody.obj || [];
    const enabledInbounds = inbounds.filter(i => i.enable);
    const inboundIds = enabledInbounds.map(i => i.id);
    
    console.log(`Found ${inbounds.length} inbounds, ${enabledInbounds.length} enabled`);
    console.log('Inbound IDs:', inboundIds);

    if (inboundIds.length === 0) {
      console.log('No enabled inbounds found! Cannot create client.');
      await prisma.$disconnect();
      return;
    }

    // Test 1: Try with MINIMAL payload (only required fields)
    const testEmail = 'TAZA_test_' + Date.now();
    const minimalPayload = {
      client: {
        email: testEmail,
        totalGB: 0,
        expiryTime: 0,
        tgId: 0,
        limitIp: 0,
        enable: true,
      },
      inboundIds: inboundIds,
    };
    
    console.log('\n--- TEST 1: Minimal payload ---');
    console.log('Payload:', JSON.stringify(minimalPayload, null, 2));
    
    const addRes1 = await fetch(`${baseUrl}/panel/api/clients/add`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-CSRF-Token': csrfToken,
        Cookie: cookie,
      },
      body: JSON.stringify(minimalPayload),
    });
    
    const addBody1 = await addRes1.json();
    console.log('Response status:', addRes1.status);
    console.log('Response body:', JSON.stringify(addBody1, null, 2));

    if (addBody1.success) {
      console.log(`✓ Client ${testEmail} created successfully!`);
      
      // Verify by fetching the client
      const getRes = await fetch(`${baseUrl}/panel/api/clients/get/${encodeURIComponent(testEmail)}`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'X-CSRF-Token': csrfToken,
          Cookie: cookie,
        },
      });
      const getBody = await getRes.json();
      console.log('Get client response:', JSON.stringify(getBody, null, 2));
    } else {
      console.log(`✗ Client creation failed: ${addBody1.msg}`);
      
      // Try alternative format - send as form data
      console.log('\n--- Trying alternative API format ---');
    }

    // Test 2: Try with email only (no other fields)
    const testEmail2 = 'TAZA_test2_' + Date.now();
    const payload2 = {
      client: {
        email: testEmail2,
      },
      inboundIds: inboundIds,
    };
    
    console.log('\n--- TEST 2: Email only ---');
    console.log('Payload:', JSON.stringify(payload2, null, 2));
    
    const addRes2 = await fetch(`${baseUrl}/panel/api/clients/add`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-CSRF-Token': csrfToken,
        Cookie: cookie,
      },
      body: JSON.stringify(payload2),
    });
    
    const addBody2 = await addRes2.json();
    console.log('Response status:', addRes2.status);
    console.log('Response body:', JSON.stringify(addBody2, null, 2));

    if (addBody2.success) {
      console.log(`✓ Client ${testEmail2} created successfully!`);
    } else {
      console.log(`✗ Email-only creation failed: ${addBody2.msg}`);
    }

    // Test 3: Try with all fields including UUID
    const { randomUUID } = require('crypto');
    const testEmail3 = 'TAZA_test3_' + Date.now();
    const payload3 = {
      client: {
        email: testEmail3,
        totalGB: 1073741824, // 1GB
        expiryTime: 1735689600000,
        tgId: 0,
        limitIp: 2,
        enable: true,
      },
      inboundIds: [inboundIds[0]], // Just first inbound
    };
    
    console.log('\n--- TEST 3: Full payload ---');
    console.log('Payload:', JSON.stringify(payload3, null, 2));
    
    const addRes3 = await fetch(`${baseUrl}/panel/api/clients/add`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-CSRF-Token': csrfToken,
        Cookie: cookie,
      },
      body: JSON.stringify(payload3),
    });
    
    const addBody3 = await addRes3.json();
    console.log('Response status:', addRes3.status);
    console.log('Response body:', JSON.stringify(addBody3, null, 2));

    if (addBody3.success) {
      console.log(`✓ Client ${testEmail3} created successfully!`);
    } else {
      console.log(`✗ Full payload creation failed: ${addBody3.msg}`);
    }

  } catch (err) {
    console.error('Error during API test:', err.message);
    console.error(err.stack);
  }

  await prisma.$disconnect();
}

main().catch(err => {
  console.error('Fatal:', err);
  prisma.$disconnect();
  process.exit(1);
});