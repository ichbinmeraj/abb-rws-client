import { RwsClient, RwsError } from './dist/index.js';

const client = new RwsClient({
  host: '192.168.125.1',
  username: 'Default User',
  password: 'robotics',
});

function section(title) {
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`  ${title}`);
  console.log('─'.repeat(50));
}

async function run() {
  section('Connect');
  await client.connect();
  console.log('✓ Connected to 192.168.125.1');

  section('Controller State');
  const state = await client.getControllerState();
  console.log('Controller state:', state);

  const mode = await client.getOperationMode();
  console.log('Operation mode: ', mode);

  section('RAPID Execution');
  const execState = await client.getRapidExecutionState();
  console.log('Execution state:', execState);

  const tasks = await client.getRapidTasks();
  console.log('RAPID tasks:');
  for (const t of tasks) {
    console.log(`  ${t.name}  type=${t.type}  excstate=${t.excstate}  active=${t.active}  motion=${t.motiontask}`);
  }

  section('Motion — Joint Positions');
  const joints = await client.getJointPositions('ROB_1');
  console.log('Joint target (deg):');
  for (const [k, v] of Object.entries(joints)) {
    console.log(`  ${k}: ${v.toFixed(4)}`);
  }

  section('Motion — Cartesian Position');
  const cart = await client.getCartesianPosition('ROB_1');
  console.log(`  x=${cart.x.toFixed(2)}  y=${cart.y.toFixed(2)}  z=${cart.z.toFixed(2)}`);
  console.log(`  q1=${cart.q1.toFixed(6)}  q2=${cart.q2.toFixed(6)}  q3=${cart.q3.toFixed(6)}  q4=${cart.q4.toFixed(6)}`);

  section('Done');
  console.log('✓ All checks passed');
}

run()
  .catch(e => {
    console.error('\n✗ FAILED');
    if (e instanceof RwsError) {
      console.error(`  RwsError [${e.code}]: ${e.message}`);
      if (e.httpStatus) console.error(`  HTTP status: ${e.httpStatus}`);
      if (e.rwsDetail) console.error(`  Detail: ${e.rwsDetail}`);
    } else {
      console.error(e);
    }
    process.exit(1);
  })
  .finally(() => client.disconnect());
