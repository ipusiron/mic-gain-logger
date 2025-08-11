# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Mic Gain Logger is a web-based audio level monitoring tool designed for physical security and acoustic surveillance. It visualizes and logs microphone input levels (in dBFS) without recording actual audio, making it suitable for field investigations and security monitoring.

## Architecture

This is a client-side only web application built with vanilla JavaScript:
- **index.html**: Main UI with controls for starting/stopping monitoring, CSV export, and real-time display
- **script.js**: Core logic using Web Audio API for audio analysis, Canvas for visualization, and Blob API for CSV export
- **style.css**: Dark/light theme styling with responsive design

The application uses:
- Web Audio API for real-time audio processing (no server-side component)
- Canvas 2D context for real-time waveform visualization
- No build process or package manager - serves directly as static files
- GitHub Pages deployment at https://ipusiron.github.io/mic-gain-logger/

## Development Commands

This is a static site with no build process:
```bash
# Serve locally (any static server works)
python -m http.server 8000
# or
npx serve .
```

## Key Implementation Details

- **Audio Processing**: Uses `AnalyserNode` with configurable smoothing and FFT size (2048)
- **dBFS Calculation**: RMS to dBFS conversion with floor threshold support
- **Real-time Updates**: requestAnimationFrame loop for smooth visualization
- **CSV Export**: Timestamp + dBFS value pairs, generated client-side using Blob API
- **No Recording**: Audio stream is analyzed but never recorded or transmitted