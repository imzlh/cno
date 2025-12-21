const link = Deno.args[1];
console.log('Fetching link:', link);
const fe = await fetch(link);
if (!fe.ok) {
  console.error('Failed to fetch link:', link);
  Deno.exit(1);
}
console.log('Request successful', fe.status, fe.statusText);
console.log('Response headers:', fe.headers);
const text = await fe.text();
console.log(text);