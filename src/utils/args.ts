const os = import.meta.use('os');
export const os_args = (function(){
    const { args } = os;
    // arg_0 is always cjs binary
    for (let i = 1; i < args.length; i ++) {
        if (args[i][0] == '-') {
            if (args[i][1] == '-') i ++;
        } else {
            return args.slice(i);
        }
    }
    return [];  // this should not happened! or not running user script?
})();