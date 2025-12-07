class HttpClient {
    close(){}
    [Symbol.dispose](){}
}

Object.assign(Deno, {
    createHttpClient(opt){
        return new HttpClient();
    }
} as Partial<typeof Deno>);