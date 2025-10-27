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
			liveAgentStartForwardingBtn,
			liveAgentStopForwardingBtn,
			liveAgentClearTranscriptionBtn,
			liveAgentExportSubtitlesBtn,
			liveAgentRestartNovaBtn,
		} = this.elements;

		liveAgentStartMicBtn.addEventListener('click', this.onStartRecording);
		liveAgentStopMicBtn.addEventListener('click', this.onStopRecording);
		liveAgentStartForwardingBtn.addEventListener('click', this.onStartForwarding);
		liveAgentStopForwardingBtn.addEventListener('click', this.onStopForwarding);
		liveAgentClearTranscriptionBtn.addEventListener('click', this.onClear);

		liveAgentExportSubtitlesBtn.addEventListener('click', () => {
			const format = confirm('Export as SRT? (Cancel for WebVTT)') ? 'srt' : 'vtt';
			this.onExport(format);
		});

		liveAgentRestartNovaBtn.addEventListener('click', this.onRestartNova);
	}

	update(state: AppState) {
		const { liveAgentStartMicBtn, liveAgentStopMicBtn, liveAgentStartForwardingBtn, liveAgentStopForwardingBtn } = this.elements;

		const { isMicActive, isForwarding, pcConnected } = state.sttState;

		// Mic buttons
		setVisible(liveAgentStartMicBtn, !isMicActive);
		setVisible(liveAgentStopMicBtn, isMicActive);
		liveAgentStopMicBtn.disabled = isForwarding; // Cannot stop mic while forwarding

		// Forwarding buttons
		liveAgentStartForwardingBtn.disabled = !(isMicActive && pcConnected) || isForwarding;
		setVisible(liveAgentStartForwardingBtn, !isForwarding);
		setVisible(liveAgentStopForwardingBtn, isForwarding);
	}

	setStartRecordingLoading(loading: boolean) {
		setButtonLoading(this.elements.liveAgentStartMicBtn, loading);
	}

	setStartForwardingLoading(loading: boolean) {
		setButtonLoading(this.elements.liveAgentStartForwardingBtn, loading);
	}
}
