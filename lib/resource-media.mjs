import {pipeline} from 'node:stream/promises';
export async function sendResourceMedia(req,res,asset){
 const {handle,info,mime}=asset;let started=false;
 try{
  let start=0,end=info.size-1,status=200;
  if(req.headers.range){
   const match=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
   if(!match||(!match[1]&&!match[2])){res.writeHead(416,{'Content-Range':`bytes */${info.size}`});return res.end();}
   if(!match[1])start=Math.max(0,info.size-Number(match[2]));else start=Number(match[1]);
   if(match[1]&&match[2])end=Math.min(end,Number(match[2]));
   if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=info.size){res.writeHead(416,{'Content-Range':`bytes */${info.size}`});return res.end();}
   status=206;
  }
  res.writeHead(status,{'Content-Type':mime,'Content-Length':end-start+1,'Accept-Ranges':'bytes',...(status===206?{'Content-Range':`bytes ${start}-${end}/${info.size}`}:{})});
  if(req.method==='HEAD')return res.end();
  started=true;await pipeline(handle.createReadStream({start,end,autoClose:true}),res);
 }finally{if(!started)await handle.close();}
}
