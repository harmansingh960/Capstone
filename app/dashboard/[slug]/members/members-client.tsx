"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type SubmitEvent } from "react";
import type { MembershipRole } from "@/lib/schema";

export type MemberSummary = {
  userId: string;
  role: MembershipRole;
  name: string | null;
  email: string | null;
};

type AddableRole = "admin" | "manager" | "member";

type MembersClientProps = {
  organizationSlug: string;
  currentUserRole: MembershipRole;
  currentUserId: string;
  initialMembers: MemberSummary[];
  isPlatformAdmin?: boolean;
};

const ROLE_LABELS: Record<MembershipRole, string> = {
  admin: "Admin",
  manager: "Manager",
  member: "Member",
};

async function readApiError(
  response: Response,
  fallbackMessage: string,
): Promise<string> {
  try {
    const data = (await response.json()) as { error?: unknown };
    if (typeof data?.error === "string" && data.error.trim() !== "") {
      return data.error;
    }
  } catch {
    // Ignore non-JSON error responses and fall back to status messages.
  }

  if (response.status === 401) {
    return "Your session has expired. Please sign in again.";
  }
  if (response.status === 403) {
    return "You do not have permission to manage organization members.";
  }
  if (response.status === 404) {
    return "The requested organization or member could not be found.";
  }
  if (response.status === 409) {
    return "This action conflicts with the organization's membership rules.";
  }
  return fallbackMessage;
}

export function MembersClient({
  organizationSlug,
  currentUserRole,
  currentUserId,
  initialMembers,
  isPlatformAdmin = false,
}: MembersClientProps) {
  const router = useRouter();
  const isAdmin = currentUserRole === "admin";
  const isManager = currentUserRole === "manager";
  const canAddMember = isAdmin || isManager;

  const [members, setMembers] = useState<MemberSummary[]>(initialMembers);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  // Add member form state (admin only)
  const [addEmail, setAddEmail] = useState("");
  const [addRole, setAddRole] = useState<AddableRole>("member");
  const [addLoading, setAddLoading] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [addSuccess, setAddSuccess] = useState<string | null>(null);
  const addInFlight = useRef(false);

  // Row-level role update & removal state (admin only)
  const [actionLoadingUserId, setActionLoadingUserId] = useState<string | null>(
    null,
  );
  const [confirmingRemoveUserId, setConfirmingRemoveUserId] = useState<
    string | null
  >(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const actionInFlight = useRef(false);

  const membersApiUrl = `/api/organizations/${encodeURIComponent(organizationSlug)}/members`;

  async function refreshMembers() {
    setListLoading(true);
    setListError(null);

    try {
      const response = await fetch(membersApiUrl, {
        method: "GET",
        cache: "no-store",
      });

      if (response.status === 401) {
        router.push("/login");
        return;
      }

      if (!response.ok) {
        const message = await readApiError(
          response,
          "Failed to load organization members. Please try again.",
        );
        setListError(message);
        return;
      }

      const data = (await response.json()) as { members?: MemberSummary[] };
      setMembers(Array.isArray(data.members) ? data.members : []);
    } catch {
      setListError("Could not reach the server. Please try again.");
    } finally {
      setListLoading(false);
    }
  }

  async function onAddMember(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canAddMember || addInFlight.current) return;

    const trimmedEmail = addEmail.trim();

    if (isManager && addRole !== "member") {
      setAddError("Managers can only add members with the member role.");
      return;
    }

    if ((addRole === "manager" || addRole === "admin") && !isPlatformAdmin) {
      setAddError(
        "Only the platform administrator can grant manager or admin roles.",
      );
      return;
    }

    addInFlight.current = true;
    setAddError(null);
    setAddSuccess(null);
    setActionError(null);
    setActionSuccess(null);
    setAddLoading(true);

    try {
      const response = await fetch(membersApiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: trimmedEmail,
          role: addRole,
        }),
      });

      if (response.status === 401) {
        router.push("/login");
        return;
      }

      if (!response.ok) {
        const message = await readApiError(
          response,
          "Could not add member. Please try again.",
        );
        setAddError(message);
        return;
      }

      setAddEmail("");
      setAddRole("member");
      setAddSuccess(`Added ${trimmedEmail} as ${ROLE_LABELS[addRole]}.`);
      await refreshMembers();
      router.refresh();
    } catch {
      setAddError("Could not reach the server. Please try again.");
    } finally {
      addInFlight.current = false;
      setAddLoading(false);
    }
  }

  async function onChangeRole(member: MemberSummary, nextRole: MembershipRole) {
    if (!isAdmin || actionInFlight.current || member.role === nextRole) {
      return;
    }

    if ((nextRole === "manager" || nextRole === "admin") && !isPlatformAdmin) {
      setActionError(
        "Only the platform administrator can grant manager or admin roles.",
      );
      return;
    }

    actionInFlight.current = true;
    setActionError(null);
    setActionSuccess(null);
    setAddError(null);
    setAddSuccess(null);
    setConfirmingRemoveUserId(null);
    setActionLoadingUserId(member.userId);

    try {
      const response = await fetch(
        `${membersApiUrl}/${encodeURIComponent(member.userId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role: nextRole }),
        },
      );

      if (response.status === 401) {
        router.push("/login");
        return;
      }

      if (!response.ok) {
        const message = await readApiError(
          response,
          "Could not update member role. Please try again.",
        );
        setActionError(message);
        if (response.status === 404 || response.status === 409) {
          await refreshMembers();
        }
        return;
      }

      const displayTarget = member.name ?? member.email ?? member.userId;
      setActionSuccess(
        `Updated role for ${displayTarget} to ${ROLE_LABELS[nextRole]}.`,
      );
      await refreshMembers();
      router.refresh();
    } catch {
      setActionError("Could not reach the server. Please try again.");
    } finally {
      actionInFlight.current = false;
      setActionLoadingUserId(null);
    }
  }

  async function onConfirmRemoveMember(member: MemberSummary) {
    if (!isAdmin || actionInFlight.current) {
      return;
    }

    actionInFlight.current = true;
    setActionError(null);
    setActionSuccess(null);
    setAddError(null);
    setAddSuccess(null);
    setActionLoadingUserId(member.userId);

    try {
      const response = await fetch(
        `${membersApiUrl}/${encodeURIComponent(member.userId)}`,
        {
          method: "DELETE",
        },
      );

      if (response.status === 401) {
        router.push("/login");
        return;
      }

      if (!response.ok) {
        const message = await readApiError(
          response,
          "Could not remove member. Please try again.",
        );
        setActionError(message);
        setConfirmingRemoveUserId(null);
        if (response.status === 404 || response.status === 409) {
          await refreshMembers();
        }
        return;
      }

      setConfirmingRemoveUserId(null);
      if (member.userId === currentUserId) {
        router.push("/dashboard");
        router.refresh();
        return;
      }

      const displayTarget = member.name ?? member.email ?? member.userId;
      setActionSuccess(`Removed ${displayTarget} from the organization.`);
      await refreshMembers();
      router.refresh();
    } catch {
      setActionError("Could not reach the server. Please try again.");
    } finally {
      actionInFlight.current = false;
      setActionLoadingUserId(null);
    }
  }

  const inputClassName =
    "w-full rounded border border-zinc-300 px-3 py-2 text-sm text-black dark:border-zinc-700 dark:bg-zinc-900 dark:text-white";

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-medium">
            Members ({members.length})
          </h2>
        </div>

        {!canAddMember && (
          <p className="text-xs text-zinc-500">
            Only organization admins and managers can add members. Only
            organization admins can change roles or remove members.
          </p>
        )}
        {isManager && (
          <p className="text-xs text-zinc-500">
            As an organization manager, you can add members with the Member
            role. Only organization admins can change roles or remove members.
          </p>
        )}
        {isAdmin && !isPlatformAdmin && (
          <p className="text-xs text-zinc-500">
            As an organization admin, you can add and remove members. Only the
            global platform administrator can grant Manager or Admin roles.
          </p>
        )}

        {listError && (
          <p role="alert" className="text-sm text-red-600">
            {listError}
          </p>
        )}
        {actionError && (
          <p role="alert" className="text-sm text-red-600">
            {actionError}
          </p>
        )}
        {actionSuccess && (
          <p
            role="status"
            className="text-sm text-emerald-600 dark:text-emerald-400"
          >
            {actionSuccess}
          </p>
        )}

        {listLoading ? (
          <p className="rounded border border-dashed border-zinc-300 p-4 text-sm text-zinc-500 dark:border-zinc-700">
            Loading members…
          </p>
        ) : members.length === 0 ? (
          <p className="rounded border border-dashed border-zinc-300 p-4 text-sm text-zinc-500 dark:border-zinc-700">
            No members found for this organization.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {members.map((member) => {
              const isBusy = actionLoadingUserId === member.userId;
              const isConfirmingRemove =
                confirmingRemoveUserId === member.userId;
              const isCurrentUser = member.userId === currentUserId;
              const hasName =
                typeof member.name === "string" && member.name.trim() !== "";
              const hasEmail =
                typeof member.email === "string" && member.email.trim() !== "";
              const primaryLabel = hasName
                ? member.name
                : hasEmail
                  ? member.email
                  : member.userId;

              return (
                <li
                  key={member.userId}
                  className="flex flex-col gap-3 rounded border border-zinc-200 p-4 dark:border-zinc-800"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex flex-col gap-0.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{primaryLabel}</span>
                        {isCurrentUser && (
                          <span className="rounded bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                            You
                          </span>
                        )}
                      </div>
                      {hasEmail && (
                        <span className="text-xs text-zinc-600 dark:text-zinc-400">
                          {member.email}
                        </span>
                      )}
                      <span className="text-xs text-zinc-500">
                        User ID: <code>{member.userId}</code>
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {isAdmin ? (
                        <>
                          <label className="flex items-center gap-1.5 text-xs">
                            <span className="sr-only">
                              Role for {primaryLabel}
                            </span>
                            <select
                              aria-label={`Role for ${primaryLabel}`}
                              disabled={isBusy}
                              value={member.role}
                              onChange={(event) =>
                                void onChangeRole(
                                  member,
                                  event.target.value as MembershipRole,
                                )
                              }
                              className="rounded border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium text-zinc-800 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
                            >
                              <option
                                value="admin"
                                disabled={
                                  !isPlatformAdmin && member.role !== "admin"
                                }
                              >
                                Admin
                                {!isPlatformAdmin
                                  ? " (Platform Admin only)"
                                  : ""}
                              </option>
                              <option
                                value="manager"
                                disabled={
                                  !isPlatformAdmin && member.role !== "manager"
                                }
                              >
                                Manager
                                {!isPlatformAdmin
                                  ? " (Platform Admin only)"
                                  : ""}
                              </option>
                              <option value="member">Member</option>
                            </select>
                          </label>
                          {!isConfirmingRemove && (
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => {
                                setActionError(null);
                                setActionSuccess(null);
                                setConfirmingRemoveUserId(member.userId);
                              }}
                              className="rounded border border-red-300 px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-60 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40"
                            >
                              Remove
                            </button>
                          )}
                        </>
                      ) : (
                        <span className="rounded bg-zinc-100 px-2.5 py-1 text-xs font-medium capitalize text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                          {ROLE_LABELS[member.role]}
                        </span>
                      )}
                    </div>
                  </div>

                  {isAdmin && isConfirmingRemove && (
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-red-200 bg-red-50/70 p-2.5 text-xs text-red-900 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200">
                      <span>
                        Remove <strong>{primaryLabel}</strong> from this
                        organization? Their registered account and historical
                        task assignments will be preserved.
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void onConfirmRemoveMember(member)}
                          className="rounded bg-red-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-60"
                        >
                          {isBusy ? "Removing…" : "Confirm remove"}
                        </button>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => setConfirmingRemoveUserId(null)}
                          className="rounded border border-zinc-300 bg-white px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {canAddMember && (
        <form
          onSubmit={(event) => void onAddMember(event)}
          className="flex flex-col gap-3 rounded border border-zinc-200 p-4 dark:border-zinc-800"
        >
          <h2 className="text-lg font-medium">Add organization member</h2>
          <p className="text-xs text-zinc-500">
            {isManager
              ? "Add an existing registered user as a member by their account email address."
              : "Add an existing registered user by their account email address."}
          </p>
          <label className="flex flex-col gap-1 text-sm">
            User email
            <input
              name="email"
              type="email"
              required
              maxLength={254}
              value={addEmail}
              onChange={(event) => setAddEmail(event.target.value)}
              placeholder="teammate@example.com"
              className={inputClassName}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Role
            <select
              name="role"
              value={addRole}
              onChange={(event) =>
                setAddRole(event.target.value as AddableRole)
              }
              className={inputClassName}
            >
              <option value="member">Member</option>
              {isAdmin && (
                <>
                  <option value="manager" disabled={!isPlatformAdmin}>
                    Manager{!isPlatformAdmin ? " (Platform Admin only)" : ""}
                  </option>
                  <option value="admin" disabled={!isPlatformAdmin}>
                    Admin{!isPlatformAdmin ? " (Platform Admin only)" : ""}
                  </option>
                </>
              )}
            </select>
          </label>
          {addError && (
            <p role="alert" className="text-sm text-red-600">
              {addError}
            </p>
          )}
          {addSuccess && (
            <p
              role="status"
              className="text-sm text-emerald-600 dark:text-emerald-400"
            >
              {addSuccess}
            </p>
          )}
          <button
            type="submit"
            disabled={addLoading}
            className="self-start rounded bg-black px-3 py-2 text-sm text-white disabled:opacity-60 dark:bg-white dark:text-black"
          >
            {addLoading ? "Adding member…" : "Add member"}
          </button>
        </form>
      )}
    </div>
  );
}

