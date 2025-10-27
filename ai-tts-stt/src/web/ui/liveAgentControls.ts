/**
 * Live Agent controls UI component
 */

import { AppState } from '../types';
import { UIElements, setButtonLoading, setVisible } from './dom';

export class LiveAgentControls {
	constructor(
		private elements: UIElements,
		private onStartRecording: () => void,
		private onStopRecording: () => void,
		private onStartForwarding: () => void,
		private onStopForwarding: () => void,
		private onClear: () => void,
		private onExport: (format: 'vtt' | 'srt') => void,
		private onRestartNova: () => void
	) {
		this.bindEvents();
	}

	private bindEvents() {
		const {
			liveAgentStartMicBtn,
			liveAgentStopMicBtn,
			liveAgentClearTranscriptionBtn,
			liveAgentExportSubtitlesBtn,
			liveAgentRestartNovaBtn,
		} = this.elements;

		liveAgentStartMicBtn.addEventListener('click', this.onStartRecording);
		liveAgentStopMicBtn.addEventListener('click', this.onStopRecording);
		liveAgentClearTranscriptionBtn.addEventListener('click', this.onClear);

		liveAgentExportSubtitlesBtn.addEventListener('click', () => {
			const format = confirm('Export as SRT? (Cancel for WebVTT)') ? 'srt' : 'vtt';
			this.onExport(format);
		});

		liveAgentRestartNovaBtn.addEventListener('click', this.onRestartNova);
	}

	update(state: AppState) {
		const { liveAgentStartMicBtn, liveAgentStopMicBtn } = this.elements;

		const { isMicActive } = state.sttState;

		// Simple toggle: Start button when inactive, Stop button when active
		setVisible(liveAgentStartMicBtn, !isMicActive);
		setVisible(liveAgentStopMicBtn, isMicActive);
	}

	setStartRecordingLoading(loading: boolean) {
		setButtonLoading(this.elements.liveAgentStartMicBtn, loading);
	}

	setStartForwardingLoading(loading: boolean) {
		// Not used in simplified live-agent UI
	}
}
