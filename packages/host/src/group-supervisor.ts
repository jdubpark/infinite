export const GROUP_SUPERVISOR = `
  const {spawn}=require('node:child_process');
  const child=spawn(process.argv[1],process.argv.slice(2),{detached:true,stdio:['ignore','pipe','pipe']});
  let stopping=false;
  const kill=signal=>{if(child.pid&&child.exitCode===null&&child.signalCode===null)try{process.kill(-child.pid,signal)}catch{}};
  const stop=()=>{if(stopping)return;stopping=true;kill('SIGTERM');setTimeout(()=>{kill('SIGKILL');process.exit(1)},2000)};
  process.on('exit',()=>kill('SIGKILL'));
  process.stdout.on('error',stop);process.stderr.on('error',stop);
  child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
  process.stdin.resume();process.stdin.on('end',stop);process.stdin.on('error',stop);
  for(const signal of ['SIGINT','SIGTERM','SIGHUP'])process.on(signal,stop);
  child.on('error',()=>process.exit(1));
  child.on('exit',code=>process.exit(code??1));
`;
