import Foundation
import Observation
import Models
import DesignSystem

// ---------------------------------------------------------------------------
// Add / edit a project budget.
//
// The bearer-token API this app can reach is READ-ONLY (`GET /api/budget-status`
// is the only authenticated call — see ARCHITECTURE-CONTRACT.md). There is no
// project-mutation endpoint reachable from the app today, so this lane models
// add/edit behind a small protocol seam and ships a fully-working *local* store
// so the UI, previews, and tests are complete. When the backend gains a
// `POST/PATCH /api/projects` route, the Assemble/backend agent swaps the local
// store for a networked implementation of `ProjectBudgetEditing` — no view
// changes required.
// ---------------------------------------------------------------------------

/// A validated, user-editable draft of a project budget.
public struct ProjectBudgetDraft: Equatable, Sendable {
    public var name: String
    public var details: String
    /// Raw text as typed (e.g. "$1,234.50" or "400"); parsed on validation.
    public var monthlyBudgetInput: String

    public init(name: String = "", details: String = "", monthlyBudgetInput: String = "") {
        self.name = name
        self.details = details
        self.monthlyBudgetInput = monthlyBudgetInput
    }

    /// Seed a draft from an existing project for editing.
    public init(editing project: ProjectBudgetStatus) {
        self.name = project.name
        self.details = project.description ?? ""
        if let budget = project.monthlyBudgetUsd, budget > 0 {
            // Present without a currency symbol so the field stays easy to edit.
            self.monthlyBudgetInput = budget.formatted(.number.precision(.fractionLength(0...2)).grouping(.never))
        } else {
            self.monthlyBudgetInput = ""
        }
    }

    public var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    public var trimmedDetails: String { details.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// The parsed budget: `nil` when the field is blank (a project with no
    /// budget cap), a value when it parses, and a thrown error when it is
    /// non-blank but invalid.
    public func parsedBudget() throws -> Double? {
        let raw = monthlyBudgetInput.trimmingCharacters(in: .whitespacesAndNewlines)
        if raw.isEmpty { return nil }
        guard let value = CurrencyInputParser.parse(raw) else {
            throw ProjectBudgetDraftError.budgetNotANumber
        }
        guard value > 0 else { throw ProjectBudgetDraftError.budgetNotPositive }
        guard value <= 100_000_000 else { throw ProjectBudgetDraftError.budgetTooLarge }
        return value
    }

    /// Validate the whole draft, returning the parsed budget on success.
    @discardableResult
    public func validate() throws -> Double? {
        guard !trimmedName.isEmpty else { throw ProjectBudgetDraftError.nameRequired }
        guard trimmedName.count <= 80 else { throw ProjectBudgetDraftError.nameTooLong }
        return try parsedBudget()
    }

    /// Cheap check for enabling the Save button without surfacing an error.
    /// `try?` yields `.some(_)` on success (even for a blank/`nil` budget) and
    /// `nil` when `validate()` throws — so this is `true` only when valid.
    public var isValid: Bool { (try? validate()) != nil }
}

/// Typed, user-presentable validation failures.
public enum ProjectBudgetDraftError: Error, Equatable, Sendable {
    case nameRequired
    case nameTooLong
    case budgetNotANumber
    case budgetNotPositive
    case budgetTooLarge

    public var message: String {
        switch self {
        case .nameRequired: return "Give the project a name."
        case .nameTooLong: return "Keep the name under 80 characters."
        case .budgetNotANumber: return "Enter the monthly budget as a number, e.g. 400."
        case .budgetNotPositive: return "The budget must be greater than $0. Leave it blank for no cap."
        case .budgetTooLarge: return "That budget looks too large — double-check the amount."
        }
    }
}

/// Parses free-typed currency into an exact `Double`, tolerating a leading
/// symbol, thousands separators, and surrounding whitespace.
public enum CurrencyInputParser {
    public static func parse(_ input: String) -> Double? {
        var cleaned = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return nil }
        // Strip common currency symbols and grouping separators; keep digits,
        // one decimal separator, and a leading minus.
        cleaned = cleaned.replacingOccurrences(of: "$", with: "")
        cleaned = cleaned.replacingOccurrences(of: "\u{00A0}", with: "")
        cleaned = cleaned.replacingOccurrences(of: " ", with: "")
        cleaned = cleaned.replacingOccurrences(of: ",", with: "")
        guard !cleaned.isEmpty else { return nil }
        // Reject anything that isn't a plain decimal number now.
        let allowed = CharacterSet(charactersIn: "0123456789.-")
        guard cleaned.unicodeScalars.allSatisfy({ allowed.contains($0) }) else { return nil }
        guard let value = Double(cleaned), value.isFinite else { return nil }
        return value
    }
}

/// The budget-level thresholds the app derives locally when it must recompute a
/// project's status after a local edit (the backend owns the authoritative
/// value on real fetches). Warning at 80% of budget; exceeded past 100%.
public enum ProjectBudgetLevelRule {
    public static func level(spent: Double, budget: Double?) -> BudgetLevel {
        guard let budget, budget > 0 else { return .unconfigured }
        if spent > budget { return .exceeded }
        if spent >= budget * 0.8 { return .warning }
        return .ok
    }
}

// MARK: - Persistence seam

/// The write side of project budgets. Implemented locally today; a networked
/// implementation drops in unchanged when the backend exposes a mutation route.
public protocol ProjectBudgetEditing: Sendable {
    /// Create or update a project from a validated draft, returning the stored
    /// project. `current == nil` creates a new project; otherwise it updates
    /// `current` in place — preserving its real spend/coverage while applying
    /// the draft's name/description/budget.
    func save(_ draft: ProjectBudgetDraft, updating current: ProjectBudgetStatus?) async throws -> ProjectBudgetStatus
}

/// A local, in-memory implementation that makes add/edit fully functional
/// without a backend. It keeps an overlay keyed by project id (edits) plus any
/// newly-created projects, and merges them over the read-only list from
/// `BudgetStore` so the user sees their change immediately.
///
/// Marked `@MainActor` so its `@Observable` overlay drives SwiftUI directly.
@MainActor
@Observable
public final class LocalProjectBudgetStore: ProjectBudgetEditing {
    /// Edits/creates keyed by project id, applied on top of the fetched list.
    public private(set) var overlay: [String: ProjectBudgetStatus] = [:]
    /// Ids of projects created in-app (kept even when absent from the fetch).
    public private(set) var createdOrder: [String] = []

    public init() {}

    /// Merge local edits/creations over the authoritative fetched projects.
    public func merged(with fetched: [ProjectBudgetStatus]) -> [ProjectBudgetStatus] {
        var result: [ProjectBudgetStatus] = fetched.map { overlay[$0.id] ?? $0 }
        let fetchedIDs = Set(fetched.map(\.id))
        // Append locally-created projects not present in the fetch, in order.
        for id in createdOrder where !fetchedIDs.contains(id) {
            if let project = overlay[id] { result.append(project) }
        }
        return result
    }

    nonisolated public func save(_ draft: ProjectBudgetDraft, updating current: ProjectBudgetStatus?) async throws -> ProjectBudgetStatus {
        let budget = try draft.validate()
        return await MainActor.run {
            // Prefer the freshest known state: an existing overlay edit wins over
            // the passed-in snapshot, so repeated edits compose correctly.
            let base = current.flatMap { overlay[$0.id] } ?? current
            let spent = base?.spentUsd ?? 0
            let projected = base?.projectedEomUsd ?? spent
            let id = base?.id ?? "proj_local_\(UUID().uuidString.prefix(8))"
            let level = ProjectBudgetLevelRule.level(spent: spent, budget: budget)
            let percent: Double? = {
                guard let budget, budget > 0 else { return nil }
                return spent / budget
            }()
            let remaining: Double? = budget.map { $0 - spent }
            let project = ProjectBudgetStatus(
                id: id,
                name: draft.trimmedName,
                description: draft.trimmedDetails.isEmpty ? nil : draft.trimmedDetails,
                monthlyBudgetUsd: budget,
                spentUsd: spent,
                projectedEomUsd: projected,
                spendCoverage: base?.spendCoverage ?? .unknown,
                directUsd: base?.directUsd,
                allocatedUsd: base?.allocatedUsd,
                incompleteAllocatedProviderCount: base?.incompleteAllocatedProviderCount,
                remainingUsd: remaining,
                percentUsed: percent,
                status: level
            )
            overlay[id] = project
            if current == nil { createdOrder.append(id) }
            return project
        }
    }
}
