export default function BalanceBadge({
  amount,
  className = "",
}: {
  amount: number | null;
  className?: string;
}) {
  if (amount == null) {
    return (
      <span className={`text-sm text-gray-400 dark:text-gray-500 ${className}`}>--</span>
    );
  }

  const isPositive = amount >= 0;
  const formatted = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(Math.abs(amount));

  return (
    <span
      className={`inline-flex items-center text-sm font-medium ${
        isPositive
          ? "text-emerald-600 dark:text-emerald-300"
          : "text-red-600 dark:text-red-300"
      } ${className}`}
    >
      {isPositive ? formatted : `-${formatted}`}
    </span>
  );
}
