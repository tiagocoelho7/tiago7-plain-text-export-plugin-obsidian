const {
	Plugin,
	PluginSettingTab,
	Setting,
	Modal,
	Notice,
	MarkdownView,
	TFile,
	normalizePath,
	parseLinktext,
	resolveSubpath,
	stripHeading
} = require("obsidian");

const DEFAULT_SETTINGS = {
	exportFolder: "Exportações em texto",
	preserveSourceFolders: false,
	preserveHeadings: true,
	preserveLists: true,
	collapseBlankLines: true,
	expandEmbeddedNotes: true,
	indicateMissingEmbeds: true
};

const MAX_EMBED_DEPTH = 50;
const EMBED_PATTERN = /!\[\[([^\]\n]+)\]\]/g;

function safeDecodeURIComponent(value) {
	try {
		return decodeURIComponent(value);
	} catch (_error) {
		return value;
	}
}

function splitWikilinkAlias(rawInner) {
	const text = String(rawInner || "");
	let escaped = false;

	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];

		if (char === "\\" && !escaped) {
			escaped = true;
			continue;
		}

		if (char === "|" && !escaped) {
			return text.slice(0, index).trim();
		}

		escaped = false;
	}

	return text.trim();
}

function stripEmbeddedFrontmatter(source) {
	return String(source || "")
		.replace(/^\uFEFF/, "")
		.replace(/^---\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/, "");
}

function escapeRegExp(value) {
	return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function removeLeadingHeadingMarkup(source) {
	const text = String(source || "");
	const newlineIndex = text.indexOf("\n");
	const firstLine = newlineIndex === -1 ? text : text.slice(0, newlineIndex);

	if (/^\s{0,3}#{1,6}(?:\s+|$)/.test(firstLine)) {
		return newlineIndex === -1 ? "" : text.slice(newlineIndex + 1).replace(/^\n+/, "");
	}

	const lines = text.split("\n");
	if (lines.length >= 2 && /^\s*(?:=+|-+)\s*$/.test(lines[1])) {
		return lines.slice(2).join("\n").replace(/^\n+/, "");
	}

	return text;
}

function removeBlockIdentifier(source, blockId) {
	const escapedId = escapeRegExp(blockId);
	if (!escapedId) return String(source || "");

	return String(source || "")
		.replace(new RegExp(`(^|\\n)\\s*\\^${escapedId}\\s*(?=\\n|$)`, "g"), "$1")
		.replace(new RegExp(`\\s+\\^${escapedId}\\s*(?=\\n|$)`, "g"), "");
}

function getExplicitExtension(linkPath) {
	const normalized = String(linkPath || "").replace(/\\/g, "/");
	const name = normalized.split("/").pop() || "";
	const dotIndex = name.lastIndexOf(".");
	if (dotIndex <= 0 || dotIndex === name.length - 1) return "";
	return name.slice(dotIndex + 1).toLocaleLowerCase();
}

function getEmbedDisplayName(path, sourceFile) {
	const normalized = String(path || "").replace(/\\/g, "/").trim();
	if (!normalized) return sourceFile ? sourceFile.basename : "nota atual";
	const name = normalized.split("/").pop() || normalized;
	return name.replace(/\.md$/i, "");
}

function normalizeHeadingForMatch(value) {
	const decoded = safeDecodeURIComponent(String(value || ""));
	try {
		return stripHeading(decoded).toLocaleLowerCase();
	} catch (_error) {
		return decoded.trim().replace(/\s+/g, " ").toLocaleLowerCase();
	}
}

function getEmbedKey(file, subpath) {
	return `${file.path}::${safeDecodeURIComponent(String(subpath || "")).trim().toLocaleLowerCase()}`;
}

function isTiago7OpenTokenAt(text, index) {
	if (text[index] !== "{") return 0;

	if (
		text[index + 1] === "h" &&
		/[0-6]/.test(text[index + 2] || "") &&
		text[index + 3] === "{"
	) {
		return 4;
	}

	if (
		text[index + 1] === "f" &&
		/[0-9]/.test(text[index + 2] || "") &&
		text[index + 3] === "{"
	) {
		return 4;
	}

	if (text[index + 1] === "u" && text[index + 2] === "{") {
		return 3;
	}

	if (/[1-3]/.test(text[index + 1] || "") && text[index + 2] === "{") {
		return 3;
	}

	return 0;
}

function stripTiago7Syntax(text) {
	let output = "";
	let i = 0;
	let depth = 0;
	let justClosedTiago7 = false;

	while (i < text.length) {
		const openLength = isTiago7OpenTokenAt(text, i);

		if (openLength > 0) {
			depth += 1;
			i += openLength;
			justClosedTiago7 = false;
			continue;
		}

		if (text[i] === "}" && depth > 0) {
			depth -= 1;
			i += 1;
			justClosedTiago7 = true;
			continue;
		}

		// Older versions and manually nested formatting can leave one or more
		// extra closing braces immediately after a tiago7 token. They are code,
		// not visible prose, so discard that consecutive run as well.
		if (text[i] === "}" && justClosedTiago7) {
			i += 1;
			continue;
		}

		output += text[i];
		justClosedTiago7 = false;
		i += 1;
	}

	return output
		.replace(/\{h[0-6]\{/g, "")
		.replace(/\{f[0-9]\{/g, "")
		.replace(/\{u\{/g, "")
		.replace(/\{[1-3]\{/g, "");
}

function friendlyWikiTarget(rawTarget) {
	let target = String(rawTarget || "").trim();
	if (!target) return "";

	const blockIndex = target.indexOf("#^");
	const headingIndex = target.indexOf("#");

	if (blockIndex !== -1) {
		target = target.slice(0, blockIndex);
	} else if (headingIndex !== -1) {
		const filePart = target.slice(0, headingIndex);
		const headingPart = target.slice(headingIndex + 1);
		target = headingPart || filePart;
	}

	target = target.replace(/\\/g, "/");
	const parts = target.split("/");
	target = parts[parts.length - 1] || target;
	target = target.replace(/\.md$/i, "");

	return target;
}

function replaceWikiLinks(text) {
	return text.replace(/(!)?\[\[([^\]]+)\]\]/g, (_match, _embed, inner) => {
		const pipeIndex = inner.lastIndexOf("|");

		if (pipeIndex !== -1) {
			return inner.slice(pipeIndex + 1).trim();
		}

		return friendlyWikiTarget(inner);
	});
}

function replaceMarkdownLinks(text) {
	let output = text;

	// Images first, so they are not consumed by the regular-link expression.
	output = output.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_match, alt) => alt.trim());
	output = output.replace(/\[([^\]]+)\]\([^)]*\)/g, (_match, label) => label);
	output = output.replace(/<((?:https?:\/\/|mailto:)[^>]+)>/gi, "$1");

	return output;
}

function splitTableRow(line) {
	let working = line.trim();
	if (working.startsWith("|")) working = working.slice(1);
	if (working.endsWith("|")) working = working.slice(0, -1);

	const cells = [];
	let current = "";
	let escaped = false;

	for (const ch of working) {
		if (escaped) {
			current += ch;
			escaped = false;
			continue;
		}

		if (ch === "\\") {
			escaped = true;
			continue;
		}

		if (ch === "|") {
			cells.push(current.trim());
			current = "";
			continue;
		}

		current += ch;
	}

	cells.push(current.trim());
	return cells;
}

function isTableSeparator(line) {
	const trimmed = line.trim();
	if (!trimmed.includes("|")) return false;

	const cells = splitTableRow(trimmed);
	if (cells.length < 2) return false;

	return cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, "")));
}

function cleanInlineMarkdown(text) {
	let output = text;

	output = replaceWikiLinks(output);
	output = replaceMarkdownLinks(output);

	// Inline code and math delimiters: keep the visible content.
	output = output.replace(/`([^`]+)`/g, "$1");
	output = output.replace(/\$([^$\n]+)\$/g, "$1");

	// Native Obsidian formatting and common Markdown emphasis.
	for (let pass = 0; pass < 4; pass += 1) {
		output = output
			.replace(/\*\*([^*]+)\*\*/g, "$1")
			.replace(/__([^_]+)__/g, "$1")
			.replace(/~~([^~]+)~~/g, "$1")
			.replace(/==([^=]+)==/g, "$1")
			.replace(/\*([^*\n]+)\*/g, "$1")
			.replace(/_([^_\n]+)_/g, "$1");
	}

	// Footnote references and block IDs.
	output = output.replace(/\[\^[^\]]+\]/g, "");
	output = output.replace(/\s+\^[A-Za-z0-9_-]+\s*$/g, "");

	// HTML tags. Convert line breaks before removing the remaining tags.
	output = output.replace(/<br\s*\/?>/gi, "\n");
	output = output.replace(/<[^>]+>/g, "");

	// Markdown escapes.
	output = output.replace(/\\([\\`*_{}\[\]()#+\-.!|>])/g, "$1");

	return output;
}

function cleanMarkdown(source, settings) {
	let text = String(source || "")
		.replace(/^\uFEFF/, "")
		.replace(/\r\n?/g, "\n");

	// YAML frontmatter only when it is at the very beginning of the note.
	text = text.replace(/^---\n[\s\S]*?\n---\s*\n?/, "");

	// Obsidian comments and HTML comments.
	text = text.replace(/%%[\s\S]*?%%/g, "");
	text = text.replace(/<!--[\s\S]*?-->/g, "");

	// Custom tiago7 Color Tools syntax.
	text = stripTiago7Syntax(text);

	const lines = text.split("\n");
	const outputLines = [];
	let inFence = false;
	let fenceMarker = "";

	for (let rawLine of lines) {
		let line = rawLine;
		const trimmed = line.trim();

		const fenceMatch = trimmed.match(/^(```+|~~~+)/);
		if (fenceMatch) {
			const marker = fenceMatch[1][0];

			if (!inFence) {
				inFence = true;
				fenceMarker = marker;
			} else if (marker === fenceMarker) {
				inFence = false;
				fenceMarker = "";
			}

			continue;
		}

		if (inFence) {
			outputLines.push(line);
			continue;
		}

		// Remove horizontal rules.
		if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
			continue;
		}

		// Remove standalone display-math delimiters, retaining formula lines.
		if (/^\s*\$\$\s*$/.test(line)) {
			continue;
		}

		// Callouts and blockquotes.
		line = line.replace(/^\s*>\s*\[![^\]]+\][+-]?\s*/i, "");
		line = line.replace(/^\s*>\s?/, "");

		// Preserve headings as requested, while normalizing spacing.
		const headingMatch = line.match(/^\s*(#{1,6})(?:\s+|$)(.*)$/);
		if (headingMatch) {
			const headingText = cleanInlineMarkdown(headingMatch[2]).trim();
			line = settings.preserveHeadings
				? `${headingMatch[1]} ${headingText}`.trimEnd()
				: headingText;
			outputLines.push(line);
			continue;
		}

		// Footnote definitions: keep the visible explanation, remove the id.
		line = line.replace(/^\s*\[\^[^\]]+\]:\s*/, "");

		if (!settings.preserveLists) {
			line = line
				.replace(/^\s*[-*+]\s+/, "")
				.replace(/^\s*\d+[.)]\s+/, "");
		}

		line = cleanInlineMarkdown(line);
		line = line.replace(/[ \t]+$/g, "");
		outputLines.push(line);
	}

	let output = outputLines.join("\n");

	if (settings.collapseBlankLines) {
		output = output.replace(/\n{3,}/g, "\n\n");
	}

	return output.trim() + "\n";
}

async function copyToClipboard(text) {
	if (navigator.clipboard && navigator.clipboard.writeText) {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch (_error) {}
	}

	const textarea = document.createElement("textarea");
	textarea.value = text;
	textarea.setAttribute("readonly", "");
	textarea.style.position = "fixed";
	textarea.style.opacity = "0";
	document.body.appendChild(textarea);
	textarea.select();
	textarea.setSelectionRange(0, textarea.value.length);

	let success = false;
	try {
		success = document.execCommand("copy");
	} catch (_error) {
		success = false;
	}

	textarea.remove();
	return success;
}

class ExportActionsModal extends Modal {
	constructor(app, plugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("vpte-modal");
		contentEl.createEl("h2", { text: "Exportar texto limpo" });
		contentEl.createEl("p", {
			text: "Remove formatação Markdown e códigos do Cores tiago7, preservando títulos, caixas [ ] e barras verticais |."
		});

		new Setting(contentEl)
			.setName("Exportar arquivo .txt")
			.setDesc("Cria ou atualiza uma cópia limpa dentro do vault.")
			.addButton((button) => {
				button.setButtonText("Exportar").setCta().onClick(async () => {
					await this.plugin.exportCurrentNote();
					this.close();
				});
			});

		new Setting(contentEl)
			.setName("Copiar texto limpo")
			.setDesc("Copia o resultado para colar em chats, e-mails ou outros aplicativos.")
			.addButton((button) => {
				button.setButtonText("Copiar").onClick(async () => {
					await this.plugin.copyCurrentNote();
					this.close();
				});
			});

		new Setting(contentEl)
			.setName("Exportar várias notas")
			.setDesc("Escolha várias notas do vault e exporte todas de uma vez.")
			.addButton((button) => {
				button.setButtonText("Selecionar notas").onClick(() => {
					this.close();
					new MultiExportModal(this.app, this.plugin).open();
				});
			});
	}
}


class MultiExportModal extends Modal {
	constructor(app, plugin) {
		super(app);
		this.plugin = plugin;
		this.files = [];
		this.selectedPaths = new Set();
		this.query = "";
		this.listEl = null;
		this.countEl = null;
		this.exportButton = null;
	}

	onOpen() {
		const { contentEl, modalEl } = this;
		contentEl.empty();
		modalEl.addClass("vpte-multi-shell");
		contentEl.addClass("vpte-modal", "vpte-multi-modal");
		contentEl.createEl("h2", { text: "Exportar várias notas" });
		contentEl.createEl("p", {
			text: "Selecione as notas Markdown que serão convertidas em arquivos .txt limpos."
		});

		this.files = this.app.vault
			.getMarkdownFiles()
			.slice()
			.sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: "base" }));

		const activeFile = this.app.workspace.getActiveFile();
		if (activeFile instanceof TFile && activeFile.extension === "md") {
			this.selectedPaths.add(activeFile.path);
		}

		const search = contentEl.createEl("input", { cls: "vpte-search" });
		search.type = "search";
		search.placeholder = "Filtrar por nome ou pasta…";
		search.addEventListener("input", () => {
			this.query = search.value.trim().toLocaleLowerCase();
			this.renderList();
		});

		const toolbar = contentEl.createDiv({ cls: "vpte-selection-toolbar" });

		const selectVisibleButton = toolbar.createEl("button", { text: "Selecionar visíveis", attr: { type: "button" } });
		selectVisibleButton.addEventListener("click", () => {
			for (const file of this.getVisibleFiles()) {
				this.selectedPaths.add(file.path);
			}
			this.renderList();
		});

		const folderButton = toolbar.createEl("button", { text: "Pasta da nota", attr: { type: "button" } });
		folderButton.addEventListener("click", () => {
			const current = this.app.workspace.getActiveFile();
			if (!(current instanceof TFile) || current.extension !== "md") {
				new Notice("Abra uma nota Markdown para selecionar a pasta dela.");
				return;
			}

			const folderPath = current.parent ? current.parent.path : "/";
			for (const file of this.files) {
				const fileFolder = file.parent ? file.parent.path : "/";
				if (fileFolder === folderPath) {
					this.selectedPaths.add(file.path);
				}
			}
			this.renderList();
		});

		const clearButton = toolbar.createEl("button", { text: "Limpar seleção", attr: { type: "button" } });
		clearButton.addEventListener("click", () => {
			this.selectedPaths.clear();
			this.renderList();
		});

		this.countEl = contentEl.createDiv({ cls: "vpte-selection-count" });
		this.listEl = contentEl.createDiv({ cls: "vpte-file-list" });

		const footer = contentEl.createDiv({ cls: "vpte-multi-footer" });
		const cancelButton = footer.createEl("button", { text: "Cancelar", attr: { type: "button" } });
		cancelButton.addEventListener("click", () => this.close());

		this.exportButton = footer.createEl("button", {
			text: "Exportar selecionadas",
			cls: "mod-cta",
			attr: { type: "button" }
		});
		this.exportButton.addEventListener("click", async () => {
			await this.exportSelected();
		});

		this.renderList();
		setTimeout(() => search.focus(), 0);
	}

	onClose() {
		this.contentEl.empty();
		this.modalEl.removeClass("vpte-multi-shell");
	}

	getVisibleFiles() {
		if (!this.query) return this.files;
		return this.files.filter((file) => file.path.toLocaleLowerCase().includes(this.query));
	}

	renderList() {
		if (!this.listEl) return;
		this.listEl.empty();

		const visibleFiles = this.getVisibleFiles();
		if (visibleFiles.length === 0) {
			this.listEl.createDiv({ cls: "vpte-empty", text: "Nenhuma nota encontrada." });
		}

		for (const file of visibleFiles) {
			const row = this.listEl.createEl("label", { cls: "vpte-file-row" });
			const checkbox = row.createEl("input");
			checkbox.type = "checkbox";
			checkbox.checked = this.selectedPaths.has(file.path);
			checkbox.addEventListener("change", () => {
				if (checkbox.checked) {
					this.selectedPaths.add(file.path);
				} else {
					this.selectedPaths.delete(file.path);
				}
				this.updateCount();
			});

			const textWrap = row.createDiv({ cls: "vpte-file-text" });
			textWrap.createDiv({ cls: "vpte-file-name", text: file.basename });
			textWrap.createDiv({ cls: "vpte-file-path", text: file.path });
		}

		this.updateCount();
	}

	updateCount() {
		const selectedCount = this.selectedPaths.size;
		const visibleCount = this.getVisibleFiles().length;
		if (this.countEl) {
			this.countEl.setText(`${selectedCount} selecionada(s) · ${visibleCount} visível(is) · ${this.files.length} no vault`);
		}
		if (this.exportButton) {
			this.exportButton.disabled = selectedCount === 0;
		}
	}

	async exportSelected() {
		const selectedFiles = this.files.filter((file) => this.selectedPaths.has(file.path));
		if (selectedFiles.length === 0) {
			new Notice("Selecione pelo menos uma nota.");
			return;
		}

		this.exportButton.disabled = true;
		this.exportButton.setText("Exportando…");

		try {
			const result = await this.plugin.exportFiles(selectedFiles);
			if (result.failed === 0) {
				this.close();
			}
		} finally {
			if (this.exportButton) {
				this.exportButton.setText("Exportar selecionadas");
				this.exportButton.disabled = this.selectedPaths.size === 0;
			}
		}
	}
}

class Tiago7PlainTextSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "tiago7 Plain Text Export Plugin Obsidian" });

		new Setting(containerEl)
			.setName("Pasta de exportação")
			.setDesc("Pasta dentro do vault onde os arquivos .txt serão criados.")
			.addText((text) => {
				text
					.setPlaceholder("Exportações em texto")
					.setValue(this.plugin.settings.exportFolder)
					.onChange(async (value) => {
						this.plugin.settings.exportFolder = value.trim() || DEFAULT_SETTINGS.exportFolder;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Expandir notas incorporadas na exportação")
			.setDesc("Substitui ![[Nota]], ![[Nota#Cabeçalho]] e ![[Nota#^bloco]] pelo conteúdo real durante a exportação. As notas do vault não são modificadas.")
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.expandEmbeddedNotes)
					.onChange(async (value) => {
						this.plugin.settings.expandEmbeddedNotes = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Indicar incorporações não encontradas")
			.setDesc("Quando uma nota, seção ou bloco não existe, inclui uma indicação no texto exportado. Se desativado, remove silenciosamente a incorporação inválida.")
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.indicateMissingEmbeds)
					.onChange(async (value) => {
						this.plugin.settings.indicateMissingEmbeds = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Repetir estrutura de pastas da nota")
			.setDesc("Se desativado, todos os arquivos exportados ficam diretamente na pasta de exportação.")
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.preserveSourceFolders)
					.onChange(async (value) => {
						this.plugin.settings.preserveSourceFolders = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Manter títulos com #")
			.setDesc("Preserva #, ##, ### e outros níveis para manter a hierarquia visual.")
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.preserveHeadings)
					.onChange(async (value) => {
						this.plugin.settings.preserveHeadings = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Manter marcadores de listas")
			.setDesc("Preserva -, *, + e listas numeradas porque continuam legíveis em texto puro.")
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.preserveLists)
					.onChange(async (value) => {
						this.plugin.settings.preserveLists = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Reduzir linhas em branco")
			.setDesc("Limita intervalos vazios a uma única linha em branco.")
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.collapseBlankLines)
					.onChange(async (value) => {
						this.plugin.settings.collapseBlankLines = value;
						await this.plugin.saveSettings();
					});
			});
	}
}

module.exports = class Tiago7PlainTextExport extends Plugin {
	async onload() {
		await this.loadSettings();

		// Faz arquivos .txt aparecerem no explorador do Obsidian e permite abri-los.
		// O conteúdo continua sendo texto puro no disco.
		this.registerExtensions(["txt"], "markdown");

		this.addRibbonIcon("file-output", "Exportar texto limpo", () => {
			new ExportActionsModal(this.app, this).open();
		});

		this.addCommand({
			id: "export-current-note-clean-text",
			name: "Exportar nota atual como texto limpo (.txt)",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!(file instanceof TFile) || file.extension !== "md") return false;
				if (!checking) void this.exportCurrentNote();
				return true;
			}
		});

		this.addCommand({
			id: "copy-current-note-clean-text",
			name: "Copiar nota atual como texto limpo",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!(file instanceof TFile) || file.extension !== "md") return false;
				if (!checking) void this.copyCurrentNote();
				return true;
			}
		});

		this.addCommand({
			id: "open-clean-export-actions",
			name: "Abrir opções de exportação limpa",
			callback: () => new ExportActionsModal(this.app, this).open()
		});

		this.addCommand({
			id: "export-multiple-notes-clean-text",
			name: "Exportar várias notas como texto limpo…",
			callback: () => new MultiExportModal(this.app, this).open()
		});

		this.addSettingTab(new Tiago7PlainTextSettingTab(this.app, this));
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}


	async readRawMarkdownFile(file) {
		if (!(file instanceof TFile) || file.extension.toLocaleLowerCase() !== "md") {
			throw new Error("O item selecionado não é uma nota Markdown.");
		}

		const activeFile = this.app.workspace.getActiveFile();
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);

		return activeFile === file && view && view.file === file && view.editor
			? view.editor.getValue()
			: await this.app.vault.cachedRead(file);
	}

	missingEmbedMessage(message) {
		return this.settings.indicateMissingEmbeds ? message : "";
	}

	extractHeadingFallback(source, headingName) {
		const wanted = normalizeHeadingForMatch(headingName);
		const lines = String(source || "").replace(/\r\n?/g, "\n").split("\n");

		for (let index = 0; index < lines.length; index += 1) {
			const match = lines[index].match(/^\s{0,3}(#{1,6})(?:\s+|$)(.*)$/);
			if (!match) continue;

			const candidate = match[2].replace(/\s+#+\s*$/, "").trim();
			if (normalizeHeadingForMatch(candidate) !== wanted) continue;

			const level = match[1].length;
			let end = index + 1;
			while (end < lines.length) {
				const nextHeading = lines[end].match(/^\s{0,3}(#{1,6})(?:\s+|$)/);
				if (nextHeading && nextHeading[1].length <= level) break;
				end += 1;
			}

			return {
				found: true,
				text: lines.slice(index + 1, end).join("\n").replace(/^\n+|\n+$/g, "")
			};
		}

		return { found: false, text: "" };
	}

	extractBlockFallback(source, blockId) {
		const escapedId = escapeRegExp(blockId);
		if (!escapedId) return { found: false, text: "" };

		const lines = String(source || "").replace(/\r\n?/g, "\n").split("\n");
		const marker = new RegExp(`(?:^|\\s)\\^${escapedId}\\s*$`);
		let markerIndex = -1;

		for (let index = 0; index < lines.length; index += 1) {
			if (marker.test(lines[index])) {
				markerIndex = index;
				break;
			}
		}

		if (markerIndex === -1) return { found: false, text: "" };

		let start = markerIndex;
		while (start > 0 && lines[start - 1].trim() !== "" && !/^\s{0,3}#{1,6}(?:\s+|$)/.test(lines[start - 1])) {
			start -= 1;
		}

		let end = markerIndex + 1;
		while (end < lines.length && lines[end].trim() !== "" && !/^\s{0,3}#{1,6}(?:\s+|$)/.test(lines[end])) {
			end += 1;
		}

		return {
			found: true,
			text: removeBlockIdentifier(lines.slice(start, end).join("\n"), blockId).trim()
		};
	}

	extractEmbeddedSubpath(source, file, subpath) {
		const cache = this.app.metadataCache.getFileCache(file);

		if (cache) {
			try {
				const resolved = resolveSubpath(cache, subpath);
				if (resolved && resolved.start && Number.isFinite(resolved.start.offset)) {
					const start = Math.max(0, Math.min(source.length, resolved.start.offset));
					const rawEnd = resolved.end && Number.isFinite(resolved.end.offset)
						? resolved.end.offset
						: source.length;
					const end = Math.max(start, Math.min(source.length, rawEnd));
					let extracted = source.slice(start, end);

					if (resolved.type === "heading") {
						extracted = removeLeadingHeadingMarkup(extracted);
					} else if (resolved.type === "block") {
						extracted = removeBlockIdentifier(extracted, subpath.replace(/^#\^/, ""));
					}

					return { found: true, text: extracted.trim() };
				}
			} catch (error) {
				console.warn("tiago7 Plain Text Export Plugin Obsidian — falha ao resolver subcaminho pelo cache:", error);
			}
		}

		if (subpath.startsWith("#^")) {
			return this.extractBlockFallback(source, safeDecodeURIComponent(subpath.slice(2)));
		}

		if (subpath.startsWith("#")) {
			return this.extractHeadingFallback(source, safeDecodeURIComponent(subpath.slice(1)));
		}

		return { found: false, text: "" };
	}

	async expandSingleEmbed(rawInner, sourceFile, stack, depth) {
		const linktext = splitWikilinkAlias(rawInner);
		const parsed = parseLinktext(linktext);
		const linkPath = String(parsed.path || "").trim();
		const subpath = String(parsed.subpath || "").trim();
		const displayName = getEmbedDisplayName(linkPath, sourceFile);
		const explicitExtension = getExplicitExtension(linkPath);

		let targetFile = null;
		if (!linkPath) {
			targetFile = sourceFile;
		} else {
			targetFile = this.app.metadataCache.getFirstLinkpathDest(linkPath, sourceFile.path);
		}

		if (!(targetFile instanceof TFile)) {
			if (explicitExtension && explicitExtension !== "md") {
				return `[Anexo incorporado: ${linkPath.replace(/\\/g, "/").split("/").pop() || linkPath}]`;
			}

			return this.missingEmbedMessage(`[Nota incorporada não encontrada: ${displayName}]`);
		}

		if (targetFile.extension.toLocaleLowerCase() !== "md") {
			return `[Anexo incorporado: ${targetFile.name}]`;
		}

		const referenceKey = getEmbedKey(targetFile, subpath);
		if (stack.has(referenceKey)) {
			return `[Incorporação circular ignorada: ${targetFile.basename}]`;
		}

		if (depth >= MAX_EMBED_DEPTH) {
			return `[Limite de incorporações atingido: ${targetFile.basename}]`;
		}

		let embeddedSource = await this.readRawMarkdownFile(targetFile);
		if (subpath) {
			const extracted = this.extractEmbeddedSubpath(embeddedSource, targetFile, subpath);
			if (!extracted.found) {
				if (subpath.startsWith("#^")) {
					return this.missingEmbedMessage(`[Bloco incorporado não encontrado: ${displayName}${subpath}]`);
				}
				return this.missingEmbedMessage(`[Seção incorporada não encontrada: ${displayName}${subpath}]`);
			}
			embeddedSource = extracted.text;
		} else {
			embeddedSource = stripEmbeddedFrontmatter(embeddedSource);
		}

		const nextStack = new Set(stack);
		nextStack.add(referenceKey);
		const expanded = await this.expandEmbeddedNotes(embeddedSource, targetFile, nextStack, depth + 1);
		return expanded.trim();
	}

	async expandEmbedsInSegment(segment, sourceFile, stack, depth) {
		let output = "";
		let lastIndex = 0;
		const pattern = new RegExp(EMBED_PATTERN.source, "g");
		let match;

		while ((match = pattern.exec(segment)) !== null) {
			output += segment.slice(lastIndex, match.index);
			output += await this.expandSingleEmbed(match[1], sourceFile, stack, depth);
			lastIndex = match.index + match[0].length;
		}

		output += segment.slice(lastIndex);
		return output;
	}

	async expandEmbeddedNotes(source, sourceFile, stack, depth = 0) {
		const text = String(source || "");
		const lines = text.match(/[^\n]*(?:\n|$)/g) || [];
		let output = "";
		let inFence = false;
		let fenceCharacter = "";
		let fenceLength = 0;

		for (const line of lines) {
			if (!line) continue;
			const lineWithoutBreak = line.endsWith("\n") ? line.slice(0, -1) : line;
			const fence = lineWithoutBreak.match(/^\s*(`{3,}|~{3,})/);

			if (fence) {
				const marker = fence[1];
				if (!inFence) {
					inFence = true;
					fenceCharacter = marker[0];
					fenceLength = marker.length;
				} else if (marker[0] === fenceCharacter && marker.length >= fenceLength) {
					inFence = false;
					fenceCharacter = "";
					fenceLength = 0;
				}
				output += line;
				continue;
			}

			if (inFence) {
				output += line;
				continue;
			}

			output += await this.expandEmbedsInSegment(line, sourceFile, stack, depth);
		}

		return output;
	}

	async readNoteFile(file) {
		const source = await this.readRawMarkdownFile(file);
		const expandedSource = this.settings.expandEmbeddedNotes
			? await this.expandEmbeddedNotes(source, file, new Set([getEmbedKey(file, "")]))
			: source;

		return {
			file,
			text: cleanMarkdown(expandedSource, this.settings)
		};
	}

	getUniqueBatchExportPath(file, usedPaths) {
		const firstPath = this.getExportPath(file);
		if (!usedPaths.has(firstPath)) {
			usedPaths.add(firstPath);
			return firstPath;
		}

		const slashIndex = firstPath.lastIndexOf("/");
		const folder = slashIndex === -1 ? "" : firstPath.slice(0, slashIndex + 1);
		const filename = slashIndex === -1 ? firstPath : firstPath.slice(slashIndex + 1);
		const dotIndex = filename.toLocaleLowerCase().endsWith(".txt") ? filename.length - 4 : -1;
		const stem = dotIndex === -1 ? filename : filename.slice(0, dotIndex);
		const extension = dotIndex === -1 ? "" : filename.slice(dotIndex);

		let number = 2;
		let candidate = `${folder}${stem} (${number})${extension}`;
		while (usedPaths.has(candidate)) {
			number += 1;
			candidate = `${folder}${stem} (${number})${extension}`;
		}

		usedPaths.add(candidate);
		return normalizePath(candidate);
	}

	async exportFiles(files) {
		const markdownFiles = files.filter((file) => file instanceof TFile && file.extension === "md");
		const usedPaths = new Set();
		const errors = [];
		let exported = 0;

		for (const file of markdownFiles) {
			try {
				const result = await this.readNoteFile(file);
				const exportPath = this.getUniqueBatchExportPath(file, usedPaths);
				const folderPath = exportPath.includes("/")
					? exportPath.slice(0, exportPath.lastIndexOf("/"))
					: "";

				await this.ensureFolder(folderPath);
				await this.writeAndVerifyTextFile(exportPath, result.text);
				exported += 1;
			} catch (error) {
				errors.push({
					file: file.path,
					message: error && error.message ? error.message : String(error)
				});
			}
		}

		if (errors.length === 0) {
			new Notice(`${exported} nota(s) exportada(s) com sucesso.`);
		} else {
			console.error("tiago7 Plain Text Export Plugin Obsidian — exportação múltipla:", errors);
			new Notice(`${exported} exportada(s); ${errors.length} falharam. Veja o console para detalhes.`);
		}

		return {
			exported,
			failed: errors.length,
			errors
		};
	}

	async readCurrentNote() {
		const file = this.app.workspace.getActiveFile();
		if (!(file instanceof TFile) || file.extension !== "md") {
			new Notice("Abra uma nota Markdown antes de exportar.");
			return null;
		}

		return await this.readNoteFile(file);
	}

	async ensureFolder(folderPath) {
		const normalized = normalizePath(folderPath || "");
		if (!normalized) return;

		const parts = normalized.split("/").filter(Boolean);
		let current = "";

		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			const existing = this.app.vault.getAbstractFileByPath(current);

			if (!existing) {
				await this.app.vault.createFolder(current);
			} else if (existing instanceof TFile) {
				throw new Error(`Não foi possível criar a pasta: ${current}`);
			}
		}
	}

	getExportPath(file) {
		const exportRoot = normalizePath(this.settings.exportFolder || DEFAULT_SETTINGS.exportFolder);
		const sourceFolder = file.parent && file.parent.path !== "/" ? file.parent.path : "";
		const useSourceFolder = this.settings.preserveSourceFolders && sourceFolder;
		const relativeFolder = useSourceFolder ? `${exportRoot}/${sourceFolder}` : exportRoot;
		return normalizePath(`${relativeFolder}/${file.basename}.txt`);
	}

	async writeAndVerifyTextFile(exportPath, text) {
		const normalized = normalizePath(exportPath);
		const adapter = this.app.vault.adapter;
		const abstractFile = this.app.vault.getAbstractFileByPath(normalized);

		if (abstractFile instanceof TFile) {
			await this.app.vault.modify(abstractFile, text);
		} else if (abstractFile) {
			throw new Error("Já existe uma pasta com o mesmo nome do arquivo exportado.");
		} else {
			const alreadyExists = await adapter.exists(normalized);
			if (alreadyExists) {
				await adapter.write(normalized, text);
			} else {
				await this.app.vault.create(normalized, text);
			}
		}

		const existsAfterWrite = await adapter.exists(normalized);
		if (!existsAfterWrite) {
			throw new Error("O Obsidian não confirmou a criação do arquivo.");
		}

		const savedText = await adapter.read(normalized);
		if (savedText !== text) {
			throw new Error("O arquivo foi criado, mas o conteúdo gravado não corresponde ao texto exportado.");
		}
	}


	async exportCurrentNote() {
		try {
			const result = await this.readCurrentNote();
			if (!result) return;

			const exportPath = this.getExportPath(result.file);
			const folderPath = exportPath.includes("/")
				? exportPath.slice(0, exportPath.lastIndexOf("/"))
				: "";

			await this.ensureFolder(folderPath);

			await this.writeAndVerifyTextFile(exportPath, result.text);

			new Notice(`Texto limpo exportado e verificado: ${exportPath}`);
		} catch (error) {
			console.error("tiago7 Plain Text Export Plugin Obsidian:", error);
			new Notice(`Falha ao exportar: ${error && error.message ? error.message : error}`);
		}
	}

	async copyCurrentNote() {
		try {
			const result = await this.readCurrentNote();
			if (!result) return;

			const copied = await copyToClipboard(result.text);
			if (copied) {
				new Notice("Texto limpo copiado.");
			} else {
				new Notice("Não foi possível copiar automaticamente.");
			}
		} catch (error) {
			console.error("tiago7 Plain Text Export Plugin Obsidian:", error);
			new Notice(`Falha ao copiar: ${error && error.message ? error.message : error}`);
		}
	}
};
