# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Mic Gain Logger is a web-based audio level monitoring tool designed for physical security and acoustic surveillance. It visualizes and logs microphone input levels (in dBFS) without recording actual audio, making it suitable for field investigations and security monitoring.

Part of the "生成AIで作るセキュリティツール100" (100 Security Tools with AI) project - Day041.

## Architecture

Client-side only web application (vanilla JavaScript, no build step):

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   index.html    │    │   script.js     │    │   style.css     │
│   (UI/Controls) │◄──►│  (Audio/Canvas) │◄──►│  (Theming)      │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

- **script.js**: Single IIFE containing all application logic
  - Audio pipeline: `getUserMedia` → `AudioContext` → `AnalyserNode` → RMS → dBFS
  - Canvas rendering via `requestAnimationFrame` loop
  - Statistics accumulation (cumulative across start/stop cycles)
  - CSV export via Blob API

## Development Commands

```bash
# Serve locally (HTTPS not required for localhost)
python -m http.server 8000
# or
npx serve .
```

No tests, linter, or build process. Changes are reflected immediately on page reload.

## Key Implementation Notes

- **Audio constraints**: All processing disabled (`echoCancellation`, `noiseSuppression`, `autoGainControl` = false) for raw audio levels
- **dBFS range**: -∞ to 0, where 0 = digital maximum. Typical values: -60 (silent) to -20 (conversation)
- **Microphone reconnection**: 300ms delay between stop and restart to avoid browser state issues (see `lastStopTime` in script.js)
- **High-DPI Canvas**: Uses `devicePixelRatio` for crisp rendering on retina displays
- **Theme persistence**: Uses localStorage for dark/light mode preference
- **Mobile responsiveness**: Dynamic button relocation at 480px breakpoint

## Browser Requirements

Requires Web Audio API and `getUserMedia`. iOS Safari needs iOS 13+.