import SwiftUI
import AppCore
import DesignSystem
import Models
import Networking

/// A live panel for the public `health`/`ready` probes. Renders even before a
/// token is entered, so a user can tell "my token is wrong" apart from "the
/// server is down". Skeleton on first load, typed error with retry on failure,
/// dependency-check rows on success.
struct ServerStatusSection: View {
    let store: ServerStatusStore
    let onReload: @Sendable () async -> Void

    var body: some View {
        Section {
            content
        } header: {
            HStack {
                Text("Server status")
                Spacer()
                if case let .loaded(snapshot) = store.state {
                    StatusBadge(
                        snapshot.overallLabel,
                        status: snapshot.overallStatus,
                        systemImage: snapshot.overallStatus == .ok ? "checkmark.circle.fill" : "exclamationmark.circle.fill"
                    )
                    .textCase(nil)
                }
            }
        } footer: {
            if case let .loaded(snapshot) = store.state {
                Text("Checked \(snapshot.fetchedAt.formatted(.relative(presentation: .named))). Pull to refresh.")
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch store.state {
        case let .failed(error):
            failure(error)
        default:
            if let snapshot = store.state.value {
                loaded(snapshot)
            } else {
                skeleton
            }
        }
    }

    private var skeleton: some View {
        ForEach(0..<3, id: \.self) { _ in
            HStack {
                SkeletonBlock(width: 90, height: 12)
                Spacer()
                SkeletonBlock(width: 60, height: 12)
            }
        }
    }

    @ViewBuilder
    private func failure(_ error: APIError) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.sm) {
                Image(systemName: "bolt.horizontal.circle.fill")
                    .foregroundStyle(Theme.Colors.warning)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                    Text(error.title)
                        .font(Theme.Typography.captionEmphasis)
                        .foregroundStyle(Theme.Colors.primaryText)
                    Text(error.message)
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Colors.secondaryText)
                }
            }
            Button {
                Task { await onReload() }
            } label: {
                Label("Try again", systemImage: "arrow.clockwise")
                    .font(Theme.Typography.caption.weight(.semibold))
            }
            .buttonStyle(.borderless)
            .tint(Theme.Colors.accent)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Server status unavailable. \(error.message)")
    }

    @ViewBuilder
    private func loaded(_ snapshot: ServerStatusSnapshot) -> some View {
        LabeledContent("Service", value: snapshot.health.service ?? "usage-monitor")

        if let version = snapshot.health.version {
            LabeledContent("Version") {
                Text(versionText(version: version, commit: snapshot.health.commit))
                    .font(.system(.body, design: .monospaced))
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
        }

        if let uptime = snapshot.health.uptimeSeconds {
            LabeledContent("Uptime", value: UptimeFormat.string(fromSeconds: uptime))
        }

        ForEach(snapshot.dependencyChecks, id: \.name) { check in
            LabeledContent(check.name) {
                StatusBadge(
                    check.ok ? "OK" : "Down",
                    status: check.ok ? .ok : .danger,
                    systemImage: check.ok ? "checkmark" : "xmark"
                )
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(check.name): \(check.ok ? "OK" : "Down")")
        }
    }

    private func versionText(version: String, commit: String?) -> String {
        guard let commit, !commit.isEmpty else { return version }
        return "\(version) · \(commit.prefix(7))"
    }
}
