import SwiftUI
import DesignSystem
import Models

/// Add or edit a project budget. Presented as a sheet. Collects name, an
/// optional description, and a monthly budget (blank = no cap), validates, and
/// persists through the injected `ProjectBudgetEditing` store.
struct ProjectBudgetEditView: View {
    @Environment(\.dismiss) private var dismiss
    @FocusState private var focus: Field?

    /// The project being edited, or `nil` when adding.
    private let existing: ProjectBudgetStatus?
    private let editStore: any ProjectBudgetEditing
    private let onSaved: (ProjectBudgetStatus) -> Void

    @State private var draft: ProjectBudgetDraft
    @State private var errorMessage: String?
    @State private var isSaving = false

    private enum Field: Hashable { case name, details, budget }

    init(
        existing: ProjectBudgetStatus?,
        editStore: any ProjectBudgetEditing,
        onSaved: @escaping (ProjectBudgetStatus) -> Void
    ) {
        self.existing = existing
        self.editStore = editStore
        self.onSaved = onSaved
        _draft = State(initialValue: existing.map(ProjectBudgetDraft.init(editing:)) ?? ProjectBudgetDraft())
    }

    private var isEditing: Bool { existing != nil }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Project name", text: $draft.name)
                        .focused($focus, equals: .name)
                        .textInputAutocapitalization(.words)
                        .submitLabel(.next)
                        .onSubmit { focus = .details }
                        .accessibilityLabel("Project name")
                    TextField("Description (optional)", text: $draft.details, axis: .vertical)
                        .focused($focus, equals: .details)
                        .lineLimit(1...3)
                        .accessibilityLabel("Project description")
                } header: {
                    Text("Project")
                } footer: {
                    Text("A short name you'll recognize in the list.")
                }

                Section {
                    HStack {
                        Text("$")
                            .foregroundStyle(Theme.Colors.secondaryText)
                        TextField("0", text: $draft.monthlyBudgetInput)
                            .focused($focus, equals: .budget)
                            .keyboardType(.decimalPad)
                            .monospacedDigit()
                            .accessibilityLabel("Monthly budget in US dollars")
                    }
                    if let preview = parsedPreview {
                        LabeledContent("Monthly budget", value: preview)
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.Colors.secondaryText)
                    }
                } header: {
                    Text("Monthly budget")
                } footer: {
                    Text("Leave blank to track spend without a budget cap. USD only.")
                }

                if let errorMessage {
                    Section {
                        Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.Colors.danger)
                            .accessibilityLabel("Error: \(errorMessage)")
                    }
                }

                if isEditing {
                    Section {
                        Text("Editing updates this project's budget locally. Actual spend continues to come from the monitor on refresh.")
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.Colors.tertiaryText)
                    }
                }
            }
            .navigationTitle(isEditing ? "Edit project" : "New project")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isEditing ? "Save" : "Add") { save() }
                        .fontWeight(.semibold)
                        .disabled(!draft.isValid || isSaving)
                }
            }
            .onAppear { if !isEditing { focus = .name } }
        }
    }

    private var parsedPreview: String? {
        guard let value = try? draft.parsedBudget() else { return nil }
        return CurrencyFormat.usd(value)
    }

    private func save() {
        do {
            try draft.validate()
        } catch let error as ProjectBudgetDraftError {
            errorMessage = error.message
            Haptics.warning()
            return
        } catch {
            errorMessage = "Something went wrong. Check the fields and try again."
            Haptics.warning()
            return
        }

        errorMessage = nil
        isSaving = true
        Task {
            do {
                let saved = try await editStore.save(draft, updating: existing)
                Haptics.success()
                isSaving = false
                onSaved(saved)
                dismiss()
            } catch let error as ProjectBudgetDraftError {
                errorMessage = error.message
                Haptics.warning()
                isSaving = false
            } catch {
                errorMessage = "Couldn't save the project. Please try again."
                Haptics.warning()
                isSaving = false
            }
        }
    }
}

// MARK: - Previews

#Preview("Add") {
    ProjectBudgetEditView(existing: nil, editStore: LocalProjectBudgetStore(), onSaved: { _ in })
}

#Preview("Edit (dark)") {
    ProjectBudgetEditView(existing: .sampleTrade, editStore: LocalProjectBudgetStore(), onSaved: { _ in })
        .preferredColorScheme(.dark)
}
