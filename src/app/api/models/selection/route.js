import { NextResponse } from 'next/server';
import { setProviderModelSelection } from '@/lib/db/repos/modelSelectionRepo.js';
export const dynamic = 'force-dynamic';
export async function POST(request) {
  const body = await request.json().catch(()=>null);
  if(typeof body?.providerAlias!=='string'||!body.providerAlias.trim()||!['clear','reset'].includes(body.action))return NextResponse.json({error:'providerAlias and clear/reset action required'},{status:400});
  try { return NextResponse.json({success:true,...await setProviderModelSelection(body.providerAlias,body.action)}); }
  catch(error){console.log('Model selection update failed:',error);return NextResponse.json({error:'Could not update model selection'},{status:500});}
}
