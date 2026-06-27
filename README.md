
# Flashback

**The Memorization Workspace**

A local-first desktop application that integrates document management, intelligent highlighting, and spaced repetition systems (SRS) into a unified environment for deep learning and long-term knowledge retention.

![Electron](https://img.shields.io/badge/Electron-47848F?logo=electron&logoColor=white)
![React](https://img.shields.io/badge/React-61DAFB?logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)

## Overview

Flashback enables users to work directly with their study materials — Markdown, PDFs, notebooks, and other documents — while seamlessly creating and reviewing context-aware flashcards. By anchoring flashcards to precise highlights within source documents, the application bridges the gap between note-taking and active recall, supporting more effective and sustainable learning.

Designed with a strong emphasis on **data portability**, **version control**, and **architectural clarity**, Flashback serves as both a practical productivity tool and a demonstration of modern desktop application development practices.

## Key Features

- **Unified Workspace**: Organize and edit documents within self-contained vaults, with automatic sidecar metadata (`.flashback` files) for flashcards, highlights, and tags.
- **Context-Aware Flashcards**: Create cards anchored to document highlights that persist through edits. Supports multiple card types including basic, reversible, cloze, type-answer, and custom HTML.
- **Advanced Spaced Repetition**: Full SRS implementation with review scheduling, ease factors, presence metrics, and detailed history logging.
- **Media Integration**: Support for images and audio in flashcards.
- **Built-in Versioning (Seal)**: Automatic Git-compatible history full audit trail of documents and metadata.
- **Powerful Organization**: Tag inheritance, category-based prioritization, and cross-document relationships.
- **Privacy-First Design**: Fully offline, local storage with no telemetry or cloud dependency.

## Getting Started

### Prerequisites
- Node.js (v18 or higher)
- npm

### Development Setup

```bash
git clone https://github.com/WeirdCatAFK/Flashback.git
cd Flashback
npm install
npm run dev
