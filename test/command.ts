const command = new Deno.Command("echo", {
    args: ["Hello, Deno.Command!"],
    stdout: "piped",
});

const { code, stdout, stderr } = await command.output();
console.log("Test 1: Basic echo command");
console.log("Exit code:", code);
console.log("Stdout:", new TextDecoder().decode(stdout));
console.log("Stderr length:", stderr.length);

const command2 = new Deno.Command("deno", {
    args: ["--version"],
    stdout: "piped",
});

const output2 = await command2.output();
console.log("\nTest 2: Deno version");
console.log("Exit code:", output2.code);
console.log("Output:", new TextDecoder().decode(output2.stdout).trim());

const command3 = new Deno.Command("sh", {
    args: ["-c", "echo $MY_VAR"],
    stdout: "piped",
    env: { MY_VAR: "custom_value_123" },
});

const output3 = await command3.output();
console.log("\nTest 3: Environment variable");
console.log("Output:", new TextDecoder().decode(output3.stdout).trim());

const command4 = new Deno.Command("cat", {
    stdin: "piped",
    stdout: "piped",
});

const child = command4.spawn();
const writer = child.stdin.getWriter();
await writer.write(new TextEncoder().encode("Hello from stdin!\n"));
writer.releaseLock();
await child.stdin.close();

const reader = child.stdout.getReader();
const chunks: Uint8Array[] = [];
while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
}
const result = new Uint8Array(chunks.reduce((acc, cur) => acc + cur.length, 0));
let offset = 0;
for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
}

console.log("\nTest 4: Spawn with stdin pipe");
console.log("Output:", new TextDecoder().decode(result).trim());

const status = await child.status;
console.log("Exit code:", status.code);

const command5 = new Deno.Command("pwd", {
    cwd: "/tmp",
    stdout: "piped",
});

const output5 = await command5.output();
console.log("\nTest 5: Working directory");
console.log("Output:", new TextDecoder().decode(output5.stdout).trim());

const command6 = new Deno.Command("sh", {
    args: ["-c", "echo stdout; echo stderr >&2"],
    stdout: "piped",
    stderr: "piped",
});

const output6 = await command6.output();
console.log("\nTest 6: Separate stdout and stderr");
console.log("Stdout:", new TextDecoder().decode(output6.stdout).trim());
console.log("Stderr:", new TextDecoder().decode(output6.stderr).trim());

const command7 = new Deno.Command("ls", {
    args: ["/nonexistent_path_12345"],
    stdout: "piped",
    stderr: "piped",
});

const output7 = await command7.output();
console.log("\nTest 7: Non-zero exit code");
console.log("Success:", output7.success);
console.log("Exit code:", output7.code);
console.log("Stderr:", new TextDecoder().decode(output7.stderr).trim());

console.log("\nAll tests completed!");
