# plumb-memory

CLI for managing and exporting Plumb memory data.

## Installation

```bash
npm install -g plumb-memory
```

## Usage

### Export memories

```bash
plumb export
```

Exports all memories to stdout in JSON format.

Options:
- `--format json|csv` — output format (default: json)
- `--output <file>` — write to file instead of stdout

### Check status

```bash
plumb status
```

Shows connection status and memory count.

### Connect to cloud

```bash
plumb connect
```

Link your local Plumb instance to the cloud sync service.

## Documentation

Full docs at [plumb.run](https://plumb.run)

## License

MIT
