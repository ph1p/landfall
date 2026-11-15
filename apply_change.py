import sys

with open('src/cli/cli.ts', 'r') as f:
    content = f.read()

# The target block in src/cli/cli.ts
old_text = """  if (argv[0] === "-v" || argv[0] === "--version" || argv[0] === "version") {
    console.log(pkg.version);
    return 0;
  }"""

new_text = """  if (argv[0] === "-v" || argv[0] === "--version" || argv[0] === "version") {
    if (process.argv.includes("--json")) {
      console.log(JSON.stringify({ version: pkg.version }));
    } else {
      console.log(pkg.version);
    }
    return 0;
  }"""

if old_text in content:
    new_content = content.replace(old_text, new_text)
    with open('src/cli/cli.ts', 'w') as f:
        f.write(new_content)
    print("Successfully applied change.")
else:
    print("Error: Could not find the target text in src/cli/cli.ts")
    sys.exit(1)
