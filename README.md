# Verilog/SystemVerilog Full Support for VS Code

This extension provides comprehensive support for Verilog and SystemVerilog development, including:

- ✅ Syntax highlighting (TextMate grammar)
- ✅ Code snippets
- ✅ Real-time linting with Verilator
- ✅ Hover information for Verilator warning/error codes

## Features

### Syntax Highlighting
Full TextMate grammar covering all SystemVerilog keywords, operators, and common constructs. Module names, instance names, ports, parameters, variables, functions, tasks, packages, and types are clearly distinguished.

### Linting (Verilator)
- Automatically run Verilator on save or on type (configurable)
- Errors and warnings are displayed as squiggles in the editor and listed in the Problems panel
- Hover over a diagnostic to see a detailed description of the error/warning code

### Snippets
Quickly insert common code structures:
- `module` → module skeleton
- `always` → always block
- `initial` → initial block
- `assign` → continuous assignment
- `interface` → SystemVerilog interface
- `class` → class definition
- `function` / `task` → function/task declaration
- `property` / `sequence` → assertion constructs

## Requirements

- **Verilator** must be installed and accessible from the command line.
  - Linux: `sudo apt install verilator`
  - macOS: `brew install verilator`
  - Windows: use WSL or download from [Veripool](https://www.veripool.org/verilator/)

## Extension Settings

This extension contributes the following settings:

* `verilog.path`: Path to the Verilator executable (default: `"verilator"`).
* `verilog.includePath`: List of include directories (converted to `-I<path>`).
* `verilog.lint.arguments`: Additional arguments for Verilator (e.g., `["-Wall"]`).
* `verilog.lint.enable`: Enable/disable lint checking (default: `true`).
* `verilog.lint.run`: When to run lint – `"onSave"` or `"onType"` (default: `"onSave"`).

## Usage

1. Open any `.v` or `.sv` file.
2. The linter will automatically run based on your settings.
3. Errors/warnings will be underlined and listed in the Problems panel.
4. Hover over a squiggle to see the error code description.
5. You can also manually trigger linting via the command **Verilog: Lint Current File**.

## Release Notes

### 0.4.0
- Removed LSP and semantic highlighting to improve performance and stability.
- Syntax highlighting is now purely based on TextMate grammar.
- Linting remains as a core feature.

### 0.3.0
- Initial LSP-based version with semantic highlighting.

## License

MIT
