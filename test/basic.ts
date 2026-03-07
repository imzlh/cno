try{
    console.log(JSON.stringify(await Deno.stat('.')))
}catch(e){
    console.log(e, e instanceof Deno.errors.IsADirectory)
}