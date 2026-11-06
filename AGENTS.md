# AGENTS.md — 설치를 맡은 코딩 에이전트를 위한 안내

이 저장소는 로컬에서 실행하는 회의록 앱입니다. 사용자가 “설치해줘”, “세팅해줘”, “실행해줘”라고 하면 아래 순서를 따르세요. 사용자는 개발자가 아닐 수 있으니 한국어로, 짧게, 다음에 무엇을 하면 되는지 위주로 안내하세요.

## 설치 순서

1. **Node.js 확인**: `node -v`
   - 22.12 이상(또는 20.19 이상)이어야 하고, **22 또는 24 LTS를 권장**합니다. 25 같은 홀수(비 LTS) 버전은 `better-sqlite3` 미리 빌드 파일이 없어 설치가 실패할 수 있습니다.
   - 없거나 너무 오래됐으면 설치 방법을 안내하세요. Windows: `winget install OpenJS.NodeJS.LTS`, macOS: nodejs.org 설치 파일. 설치 후 터미널을 새로 열어야 PATH가 잡힙니다.
2. **의존성 설치**: 저장소 루트에서 `npm install`
3. **빌드**: `npm run build`
4. **바로가기 질문**: 설치가 끝나면 반드시 사용자에게 이렇게 물어보세요.
   > 바탕화면에 바로가기를 만들까요? (‘회의록’ 실행 아이콘과 ‘회의록 종료’ 아이콘이 생깁니다)

   “네”라고 하면 `npm run shortcut`을 실행하고 결과 경로를 알려 주세요. 사용자가 묻지도 않았는데 만들지 마세요.
5. **실행**: `npm start`를 실행합니다. 서버가 백그라운드로 뜨고 기본 브라우저가 `http://127.0.0.1:4310`을 엽니다.
6. **API 키 안내**: 앱이 처음 열리면 설정 창이 뜹니다. 사용자에게 OpenAI API 키(https://platform.openai.com/api-keys)를 **앱 화면에 직접 붙여넣으라고** 안내하세요.
   - 채팅으로 키를 받아 대신 입력하지 마세요. 사용자가 원하면 저장소 루트의 `.env`에 `OPENAI_API_KEY=` 한 줄을 사용자가 직접 넣게 해도 됩니다.
7. 마지막으로 README의 “사용하기”를 3~4줄로 요약해 주세요. 회의실 회의는 마이크를 테이블 가운데 두라는 팁을 포함하세요.

## 하지 말 것

- **스피커로 소리를 재생해서 테스트하지 마세요.** 사용자가 회의 중일 수 있습니다. 음성 테스트가 필요하면 파일로만 합성하고(`say -o file.aiff`, PowerShell `System.Speech`의 `SetOutputToWaveFile`) 재생하지 마세요.
- 앱 데이터 폴더(녹음·회의록·키)를 지우지 마세요. 위치: Windows `%LOCALAPPDATA%\\MeetingNotes`, macOS `~/Library/Application Support/MeetingNotes`, Linux `~/.local/share/meeting-notes`.
- 사용자 대신 OpenAI 계정 결제·키 생성을 하지 마세요.

## 업데이트

`git pull` → `npm install` → `npm run build` → `npm run stop` → `npm start`. 녹음·회의록은 저장소 밖 앱 데이터 폴더에 있으므로 그대로 이어서 사용됩니다.

## 개발할 때

- `npm test`(vitest), `npm run typecheck`(tsc), `npm run build`(vite), `npm run dev`
- 서버는 `server/`(Fastify, better-sqlite3, ffmpeg-static), 화면은 `src/`(React). 녹음은 브라우저가 하고(`src/recorder.ts`), 서버는 WebSocket으로 받은 PCM을 디스크에 먼저 저장한 뒤 ACK합니다.
- 모델: 받아쓰기 `gpt-transcribe`, 실시간 자막 `gpt-live-transcribe`, 회의록 `gpt-6.1-terra` 기본(`server/openai-notes.ts`에서 목록·단가 관리). 단가를 바꾸면 그 파일의 날짜 주석도 갱신하세요.
